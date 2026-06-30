# Architecture

How Tarot Club decides which model answers a turn, and why it's built this way.

## The pieces

```
            ┌──────────────────────────── Tarot Club ────────────────────────────┐
            │                                                                     │
 request ──▶│  server.ts ──▶ router.ts ──▶ embedder.ts (all-MiniLM-L6-v2, local)  │
            │      │             │                                                │
            │      │             └──▶ store.ts (ratchet floor + usage stats)      │
            │      │                                                              │
            │      └──(proxy mode)──▶ OpenRouter ──▶ chosen real model            │
            └─────────────────────────────────────────────────────────────────────┘
```

| File          | Responsibility                                                        |
|---------------|-----------------------------------------------------------------------|
| `index.ts`    | Parse env, load the model + corpus, wire and start the HTTP server.   |
| `server.ts`   | HTTP surface: the proxy, `/route`, `/tiers`, `/stats`, `/healthz`, auth, body limits. |
| `router.ts`   | The decision: `classify` (scores) and `resolve` (fallback + ratchet + vision clamp). |
| `routes.ts`   | The configuration: routes, model slugs, ranks, vision flags, example corpus, thresholds. |
| `store.ts`    | Mutable state: per-conversation ratchet pins and aggregate usage stats, persisted to JSON. |
| `embedder.ts` | Wraps `@huggingface/transformers` to turn text into a normalized vector. |

## The decision, step by step

`router.resolve(query, floorRank, hasImages)` runs four stages:

### 1. Classify by meaning

At startup, every route's example phrases are embedded once (`router.init()`).
At request time the query is embedded and scored against each route. A route's
score is the **mean of its top-3 most similar example phrases** (cosine
similarity of normalized vectors, so cosine = dot product):

```
score(route) = mean( top 3 of { query · example  for example in route } )
```

Top-3 pooling means one stray example phrase can't single-handedly hijack a
route, and a route needs a few consistent matches to win. The highest-scoring
route is the candidate intent, and `margin = top1 − top2`.

Embedding is **local** (`Xenova/all-MiniLM-L6-v2`, ~22 MB, CPU/WASM). The
routing decision costs no tokens and sends nothing off-box.

### 2. Fallback guard

The candidate is only trusted if it's both confident and unambiguous:

- `score < MIN_CONFIDENCE` (0.25) → the query doesn't really resemble any
  route's examples; don't guess.
- `margin < MIN_MARGIN` (0.05) → two routes are nearly tied; the embedder can't
  separate them, so don't escalate to a pricier tier on a coin-flip.

Either condition falls back to `DEFAULT_ROUTE` (`general`, the cheapest tier).
Real intent matches typically score ~0.40–0.65, well clear of the floor.

### 3. Ratchet (per-conversation stickiness)

The store keeps a **floor rank** per `conversation_id` — the highest capability
rank that conversation has ever used. `resolve` picks the more capable of
(this turn's intent rank, the floor rank), then maps that to the
**lowest-ranked route at or above it**. So a conversation that once needed
`heavy` keeps it for the rest of the thread, even on a later trivial turn.

The ratchet only ever moves **up**. `store.commit` enforces this defensively too
— it never lowers a pin. With no `conversation_id`, there's no pin and every
turn is routed fresh (the decision still counts toward stats).

### 4. Vision clamp

If the turn carries images (`has_images`, or `image_url`/`image`/`input_image`
content parts in proxy mode) and the chosen model can't see them, escalate to
the **cheapest vision-capable route at or above the current rank**. With the
default routes, `coding` (GLM, no vision) bumps up to `heavy` (Opus, vision)
when images are attached.

The returned `route` always reports the *semantic intent* (for honest stats),
even when the ratchet or vision clamp changed the actual `model`. `source` tells
you which rule decided: `semantic`, `fallback`, `ratchet`, or `vision`.

## Why a ratchet instead of best-per-turn?

Picking the optimal model for each turn in isolation looks cheaper but usually
isn't, because of **prompt caching**. Providers cache the prefix of a
conversation per model; a cache *read* is roughly a tenth of the input price,
and a *write* a bit more than full price. The moment you switch models, the new
model has no warm prefix and must re-ingest the whole conversation cold.

So the cost model isn't "small model = cheap." It's "switches are expensive."
The ratchet minimizes switches: climb when a turn genuinely needs more, then
stay (cache stays warm). The fallback guard reinforces this by refusing to
escalate on low-confidence or near-tie turns. This is also why there is
deliberately **no decay** — letting a conversation drift back down would cause
exactly the extra switches (and cold prefills) the ratchet exists to avoid.

## State & durability

`store.ts` holds pins and counters in memory and, when given a path, mirrors
them to a JSON file:

- **Persisted** (`ARCANA_STATE_FILE`, default `data/arcana-state.json`) so a
  restart or redeploy doesn't silently downgrade live conversations.
- **Debounced, atomic writes** (write temp file, then rename) so a crash
  mid-write can't corrupt the snapshot; flushed synchronously on `SIGINT`/
  `SIGTERM`.
- **TTL eviction** — pins idle longer than 14 days are dropped on load and on
  save, so the file doesn't grow forever.
- **In-memory mode** — construct with no path (set `ARCANA_STATE_FILE=""`); used
  by the unit tests.

A JSON file (not sqlite) is deliberate: zero native dependencies, no `node-gyp`
build, which keeps the service trivial to deploy. The `Store` interface is small
enough that swapping in sqlite later — if you want queryable stats — is a
drop-in.

## Request flow in proxy mode

1. Extract the latest user message's text and image flag (`lastUserSignal`).
2. Resolve the model (the four stages above), using `conversation_id` (body) or
   the `X-Conversation-Id` header for the ratchet.
3. Commit the decision to the store (ratchet + stats).
4. Forward the original body to OpenRouter with only `model` replaced (and the
   non-standard `conversation_id` stripped), passing your `OPENROUTER_API_KEY`.
5. Stream the upstream response straight back (one pipe path for both SSE and
   non-streaming), adding `X-Arcana-Model` / `X-Arcana-Route` / `X-Arcana-Source`
   headers so a server-to-server caller can see — and hide — the real pick.

## Safety properties

- Binds **loopback** by default and **refuses** to bind a non-loopback host
  without `ARCANA_API_TOKEN` (an open `/route` would let anyone burn compute and
  write to the store).
- Constant-time token comparison (`safeEqual`, SHA-256 then `timingSafeEqual`).
- 1 MB request body cap → `413` (drains the body instead of resetting the
  socket, so the client gets a clean status, not `ECONNRESET`).
- Tightened HTTP timeouts so a slow/stuck client can't hold a connection open.
- Logs the routing decision and message length, **never** message content.
