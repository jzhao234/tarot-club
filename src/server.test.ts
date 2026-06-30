import { describe, it, expect, afterEach, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { createServer } from "./server";
import { ArcanaRouter } from "./router";
import { Store } from "./store";
import type { Embedder } from "./embedder";
import type { RouteDef } from "./routes";

class FakeEmbedder implements Embedder {
  private vocab = ["alpha", "bravo", "charlie"];
  async embed(text: string): Promise<number[]> {
    const lower = text.toLowerCase();
    const v: number[] = this.vocab.map((t) => (lower.includes(t) ? 1 : 0));
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}

const testRoutes: RouteDef[] = [
  { id: "general", model: "flash", tier: "general", rank: 0, vision: true, examples: ["alpha"] },
  { id: "coding", model: "midcoder", tier: "coding", rank: 1, vision: false, examples: ["bravo"] },
  { id: "heavy", model: "opus", tier: "heavy", rank: 2, vision: true, examples: ["charlie"] },
];

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
  vi.unstubAllGlobals();
});

async function start(token = "", openrouterKey = ""): Promise<string> {
  const srv = createServer(new ArcanaRouter(new FakeEmbedder(), testRoutes), new Store(), token, openrouterKey);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  const port = (srv.address() as AddressInfo).port;
  stop = () => srv.close();
  return `http://127.0.0.1:${port}`;
}

function post(base: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/route`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("Arcana HTTP API", () => {
  it("POST /route picks a model by meaning", async () => {
    const base = await start();
    const res = await post(base, { conversation_id: "c1", message: "please do some bravo" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model: string; route: string };
    expect(body.model).toBe("midcoder");
    expect(body.route).toBe("coding");
  });

  it("ratchets across turns (sticky, never downgrades)", async () => {
    const base = await start();
    await post(base, { conversation_id: "conv", message: "charlie work" }); // heavy → opus (rank2)
    const res = await post(base, { conversation_id: "conv", message: "now a bravo code task" }); // coding, ratchet→opus
    const body = (await res.json()) as { model: string; sticky: boolean };
    expect(body.model).toBe("opus");
    expect(body.sticky).toBe(true);
  });

  it("enforces auth when a token is set", async () => {
    const base = await start("secret");
    expect((await post(base, { message: "alpha" })).status).toBe(401);
    expect((await post(base, { message: "alpha" }, { "X-Arcana-Token": "secret" })).status).toBe(200);
    expect((await post(base, { message: "alpha" }, { Authorization: "Bearer secret" })).status).toBe(200);
  });

  it("exposes /healthz and /tiers openly", async () => {
    const base = await start("secret");
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const tiers = await fetch(`${base}/tiers`);
    expect(tiers.status).toBe(200);
    const body = (await tiers.json()) as { model: string };
    expect(body.model).toBe("arcana");
  });

  it("gates /stats behind auth and reports totals", async () => {
    const base = await start("secret");
    await post(base, { conversation_id: "c1", message: "alpha" }, { "X-Arcana-Token": "secret" });
    expect((await fetch(`${base}/stats`)).status).toBe(401);
    const ok = await fetch(`${base}/stats`, { headers: { "X-Arcana-Token": "secret" } });
    expect(ok.status).toBe(200);
    const st = (await ok.json()) as { totalRoutes: number };
    expect(st.totalRoutes).toBe(1);
  });

  it("rejects a non-string message with 400 (no 500/leak)", async () => {
    const base = await start();
    const res = await post(base, { message: 42 });
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON with 400", async () => {
    const base = await start();
    const res = await fetch(`${base}/route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects an oversized body with 413", async () => {
    const base = await start();
    const huge = "x".repeat(1_100_000);
    const res = await fetch(`${base}/route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: huge }),
    });
    expect(res.status).toBe(413);
  });

  it("returns 501 from /v1/chat/completions when no OpenRouter key is set", async () => {
    const base = await start(); // no key
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "arcana", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(501);
  });

  it("/v1/chat/completions routes by meaning + forwards to OpenRouter with the chosen model", async () => {
    const realFetch = globalThis.fetch;
    // Stub only the upstream OpenRouter call; the test client's own fetch (to
    // 127.0.0.1) passes through to the real fetch.
    vi.stubGlobal("fetch", async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("openrouter.ai")) {
        const sent = JSON.parse(init.body);
        return new Response(JSON.stringify({ ok: true, model: sent.model }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return realFetch(input, init);
    });

    const base = await start("", "test-key");
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "arcana", messages: [{ role: "user", content: "please do some bravo coding" }] }),
    });
    expect(res.status).toBe(200);
    // bravo → coding route → testRoutes coding model "midcoder"
    expect(res.headers.get("x-arcana-model")).toBe("midcoder");
    const body = (await res.json()) as { ok: boolean; model: string };
    expect(body.ok).toBe(true);
    expect(body.model).toBe("midcoder"); // upstream received the substituted model
  });
});
