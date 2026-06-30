// Arcana entrypoint: load the embedding model, precompute the route corpus, and
// serve the routing API. Run with `npm start` (tsx), or under systemd via
// deploy/arcana.service.
import { createServer } from "./server";
import { ArcanaRouter } from "./router";
import { TransformersEmbedder } from "./embedder";
import { Store } from "./store";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8090;

function parsePort(s: string | undefined, def: number): number {
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : def;
}

// Prefer explicit ARCANA_HOST/ARCANA_PORT; otherwise parse ARCANA_ADDR
// ("host:port"). A colon-less ARCANA_ADDR is treated as a host. The host
// defaults to loopback and is NEVER silently 0.0.0.0.
function parseAddr(): { host: string; port: number } {
  if (process.env.ARCANA_HOST || process.env.ARCANA_PORT) {
    return {
      host: process.env.ARCANA_HOST || DEFAULT_HOST,
      port: parsePort(process.env.ARCANA_PORT, DEFAULT_PORT),
    };
  }
  const addr = process.env.ARCANA_ADDR;
  if (!addr) return { host: DEFAULT_HOST, port: DEFAULT_PORT };
  const i = addr.lastIndexOf(":");
  if (i < 0) return { host: addr || DEFAULT_HOST, port: DEFAULT_PORT };
  return { host: addr.slice(0, i) || DEFAULT_HOST, port: parsePort(addr.slice(i + 1), DEFAULT_PORT) };
}

const { host, port } = parseAddr();
const token = process.env.ARCANA_API_TOKEN ?? "";

const isLoopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
if (!isLoopback && !token) {
  console.error(
    `arcana: refusing to bind non-loopback host ${host} without ARCANA_API_TOKEN set (open /route would let anyone burn compute and write to the store)`,
  );
  process.exit(1);
}

const router = new ArcanaRouter(new TransformersEmbedder());

console.log("arcana: loading embedding model + precomputing route corpus…");
try {
  await router.init();
} catch (err) {
  console.error("arcana: failed to load the embedding model — cannot route. Exiting.", err);
  process.exit(1);
}
console.log("arcana: model ready");

// Persist ratchet pins + stats so a restart doesn't silently downgrade live
// conversations. Defaults to ./data/arcana-state.json; override with
// ARCANA_STATE_FILE (set "" to disable persistence / run in-memory).
const stateFile = process.env.ARCANA_STATE_FILE ?? "data/arcana-state.json";
const store = new Store(stateFile ? { path: stateFile } : {});

// OPENROUTER_API_KEY enables the /v1/chat/completions proxy (Arcana picks the
// model and forwards to OpenRouter). Without it, only POST /route is available.
const openrouterKey = process.env.OPENROUTER_API_KEY ?? "";

const server = createServer(router, store, token, openrouterKey);
// Tighten the permissive node:http defaults so a slow/stuck client can't hold
// a connection open indefinitely.
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.timeout = 20_000;

server.listen(port, host, () => {
  console.log(
    `arcana listening on ${host}:${port} ` +
      `(auth ${token ? "enabled" : "disabled"}, proxy ${openrouterKey ? "enabled" : "disabled — set OPENROUTER_API_KEY"})`,
  );
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log("arcana: shutting down…");
    store.flush(); // persist the latest pins/stats before exit
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
