import http from "node:http";
import { Readable } from "node:stream";
import { createHash, timingSafeEqual } from "node:crypto";
import type { ArcanaRouter } from "./router";
import type { Store } from "./store";
import { ARCANA_MODEL } from "./routes";

// Constant-time string compare (hash to a fixed length first so differing
// lengths don't leak via timing or throw).
function safeEqual(a: string, b: string): boolean {
  const ah = createHash("sha256").update(a).digest();
  const bh = createHash("sha256").update(b).digest();
  return timingSafeEqual(ah, bh);
}

interface RouteRequest {
  conversation_id?: string;
  message?: string;
  has_images?: boolean;
}

// createServer wires Arcana's router + state behind a small HTTP API:
//   POST /v1/chat/completions  OpenAI/OpenRouter-compatible proxy: Arcana picks
//                  the model, forwards to OpenRouter with your key, and streams
//                  the reply back. Point any OpenAI client at this. (Requires
//                  openrouterKey.)
//   POST /route    decide the model for a turn WITHOUT proxying — returns the
//                  chosen slug so the caller can call the provider itself (no
//                  key needed here).
//   GET  /tiers    list the virtual model + its routes (open)
//   GET  /stats    usage breakdown by route + model (auth)
//   GET  /healthz  liveness (open)
//
// Auth: when a token is set, /route, /stats, and /v1/chat/completions require
// `Authorization: Bearer <token>` or `X-Arcana-Token: <token>`. /tiers and
// /healthz stay open. openrouterKey enables the /v1 proxy; if empty, /v1 returns
// 501 and only /route is available.
export function createServer(
  router: ArcanaRouter,
  store: Store,
  token: string,
  openrouterKey = "",
): http.Server {
  const authed = (req: http.IncomingMessage): boolean => {
    if (!token) return true;
    const header = (req.headers["x-arcana-token"] as string | undefined)?.trim();
    if (header && safeEqual(header, token)) return true;
    const auth = req.headers["authorization"];
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      return safeEqual(auth.slice("Bearer ".length).trim(), token);
    }
    return false;
  };

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error("arcana: unhandled request error:", err);
      json(res, 500, { error: "internal error" });
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = (req.url ?? "").split("?")[0];
    const method = req.method ?? "GET";

    if (method === "GET" && url === "/healthz") return text(res, 200, "ok");

    if (method === "GET" && url === "/tiers") {
      return json(res, 200, {
        model: ARCANA_MODEL,
        routes: router.routes_().map((r) => ({
          route: r.id,
          tier: r.tier,
          model: r.model,
          rank: r.rank,
          vision: r.vision,
          examples: r.examples.length,
        })),
      });
    }

    if (method === "GET" && url === "/stats") {
      if (!authed(req)) return text(res, 401, "unauthorized");
      return json(res, 200, store.stats());
    }

    if (method === "POST" && url === "/route") {
      if (!authed(req)) return text(res, 401, "unauthorized");
      let body: RouteRequest;
      try {
        body = await readJSON(req);
      } catch (e) {
        if (e instanceof Error && e.message === "PAYLOAD_TOO_LARGE") {
          return json(res, 413, { error: "payload too large" });
        }
        return json(res, 400, { error: "invalid json" });
      }
      if (typeof body.message !== "string") {
        return json(res, 400, { error: "message must be a string" });
      }
      const message = body.message.trim();
      if (!message) return json(res, 400, { error: "message is required" });

      const convId = typeof body.conversation_id === "string" ? body.conversation_id.trim() : "";
      const floor = store.floorRank(convId);
      const d = await router.resolve(message, floor, body.has_images === true);
      store.commit(convId, { rank: d.rank, model: d.model, route: d.route });

      // Privacy: log the decision, never the message content.
      console.log(
        `route conv=${shortId(convId)} route=${d.route} tier=${d.tier} model=${d.model} score=${d.score.toFixed(2)} margin=${d.margin.toFixed(2)} source=${d.source} msg_len=${message.length} images=${body.has_images === true}`,
      );

      return json(res, 200, {
        model: d.model,
        route: d.route,
        tier: d.tier,
        score: d.score,
        margin: d.margin,
        source: d.source,
        sticky: d.source === "ratchet",
      });
    }

    if (method === "POST" && url === "/v1/chat/completions") {
      if (!authed(req)) return text(res, 401, "unauthorized");
      if (!openrouterKey) {
        return json(res, 501, {
          error:
            "OPENROUTER_API_KEY is not set, so the /v1/chat/completions proxy is disabled. " +
            "Use POST /route (no key needed) to get a model slug and call your provider yourself.",
        });
      }
      let body: any;
      try {
        body = await readJSON(req);
      } catch (e) {
        if (e instanceof Error && e.message === "PAYLOAD_TOO_LARGE") return json(res, 413, { error: "payload too large" });
        return json(res, 400, { error: "invalid json" });
      }
      const messages = Array.isArray(body?.messages) ? body.messages : null;
      if (!messages || messages.length === 0) return json(res, 400, { error: "messages[] is required" });

      // Route on the latest user message; pin per conversation if an id is given
      // (body.conversation_id or the X-Conversation-Id header).
      const { text: signal, hasImages } = lastUserSignal(messages);
      const convId = (
        typeof body.conversation_id === "string"
          ? body.conversation_id
          : ((req.headers["x-conversation-id"] as string | undefined) ?? "")
      ).trim();
      const floor = store.floorRank(convId);
      const d = await router.resolve(signal, floor, hasImages);
      store.commit(convId, { rank: d.rank, model: d.model, route: d.route });
      console.log(
        `proxy conv=${shortId(convId)} route=${d.route} model=${d.model} source=${d.source} stream=${body.stream === true}`,
      );

      // Forward to OpenRouter with the chosen model substituted in. One pipe
      // path handles both streaming (SSE) and non-streaming responses.
      const upstreamBody = { ...body, model: d.model };
      delete upstreamBody.conversation_id; // our extension, not part of the OpenAI schema
      let upstream: Response;
      try {
        upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${openrouterKey}` },
          body: JSON.stringify(upstreamBody),
        });
      } catch (e) {
        return json(res, 502, { error: `upstream request failed: ${String(e)}` });
      }
      // Surface the routing decision to the (server-to-server) caller via
      // headers; the caller hides it from its own end users.
      res.writeHead(upstream.status, {
        "Content-Type": upstream.headers.get("content-type") ?? "application/json",
        "X-Arcana-Model": d.model,
        "X-Arcana-Route": d.route,
        "X-Arcana-Source": d.source,
      });
      if (upstream.body) {
        Readable.fromWeb(upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
      } else {
        res.end();
      }
      return;
    }

    return text(res, 404, "not found");
  }
}

// Pull the routing signal from the latest user message: its text, and whether
// it carries any image parts (OpenAI content can be a string or an array of
// {type:"text"|"image_url",...} parts).
function lastUserSignal(messages: any[]): { text: string; hasImages: boolean } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") return { text: c, hasImages: false };
    if (Array.isArray(c)) {
      const text = c
        .filter((p: any) => p?.type === "text")
        .map((p: any) => p.text ?? "")
        .join(" ");
      const hasImages = c.some(
        (p: any) => p?.type === "image_url" || p?.type === "image" || p?.type === "input_image",
      );
      return { text, hasImages };
    }
    return { text: "", hasImages: false };
  }
  return { text: "", hasImages: false };
}

const MAX_BODY_BYTES = 1_000_000;

function readJSON(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length; // bytes, not UTF-16 code units
      if (size > MAX_BODY_BYTES) {
        settled = true;
        // Stop buffering and reject so the handler can return a clean 413.
        // Don't destroy the socket — that would reset the connection before
        // the response flushes (client sees ECONNRESET instead of 413).
        // Further chunks are ignored via the `settled` guard above; the body
        // drains into the void.
        reject(new Error("PAYLOAD_TOO_LARGE"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString("utf8"); // safe across multibyte chunk splits
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

function text(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

function shortId(id: string): string {
  if (!id) return "-";
  return id.length <= 8 ? id : id.slice(0, 8) + "…";
}
