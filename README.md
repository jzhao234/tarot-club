# Tarot Club

> A tiny self-hosted **model router**. One virtual model, the cheapest capable
> real model behind it, picked by meaning and pinned per conversation.

**Tarot Club** exposes a single virtual model — **`arcana`** — that, for every
turn, picks the *cheapest capable* real model by **meaning** (a small embedding
model runs locally), then **pins that choice per conversation** so it only ever
upgrades, never thrashes. Point any OpenAI-compatible app at it, use the model
name `arcana`, and stop hand-picking models.

The only credential you ever need is an **OpenRouter API key**. The embedding
model is ~22 MB, runs locally on CPU, and is free.

```
your app ──(OpenAI API, model:"arcana")──▶ Tarot Club ──(picks real model)──▶ OpenRouter ──▶ Gemini / GLM / Opus / …
                                              │
                                       embeds the message,
                                       routes by intent,
                                       pins per conversation
```

---

## Contents

- [What it is](#what-it-is)
- [Why it exists](#why-it-exists)
- [Features](#features)
- [Compatibility](#compatibility)
- [Quick start](#quick-start)
- [Routes](#routes)
- [How routing works](#how-routing-works)
- [API](#api)
- [Configuration](#configuration)
- [Development & tuning](#development--tuning)
- [Deployment](#deployment)
- [Project layout](#project-layout)
- [FAQ](#faq)
- [License](#license)

Deeper docs live in [`docs/`](docs/): [architecture](docs/architecture.md) ·
[API reference](docs/api.md) · [configuration](docs/configuration.md) ·
[deployment](docs/deployment.md).

---

## What it is

Tarot Club is a small HTTP service (Node + TypeScript) that sits between your
app and a model provider. It does one job: **decide which model should answer a
given message**, cheaply and automatically.

It works two ways:

1. **As an OpenAI-compatible proxy.** Point any OpenAI client at it
   (`POST /v1/chat/completions`, model `arcana`). It routes the turn, forwards
   the request to OpenRouter with your key, and streams the answer straight
   back. Your code never names a real model.
2. **As a decide-only endpoint.** Call `POST /route` to get back *which* model
   to use, then call your provider yourself. No key needed here, no proxying.

It's conceptually like `openrouter/auto`, but with two deliberate differences
covered in [Why it exists](#why-it-exists).

## Why it exists

- **Semantic, intent-based routing.** It embeds your message
  (`all-MiniLM-L6-v2`, server-side) and matches it against per-route clusters of
  example phrases. It routes by what you *mean*, not by keyword matching, so
  paraphrases land on the right model.
- **One model per conversation (a ratchet).** It re-checks every turn but only
  ever moves *up* to a stronger model, never back down. Once a conversation has
  needed the heavy model, it keeps it. This preserves prompt-cache reuse and
  context continuity — every model switch is a cold cache prefill, so switching
  *rarely* is what makes routing cheaper, not just picking the small model.

## Features

- **Single virtual model** (`arcana`) — callers never hard-code a real model.
- **Local semantic routing** — embeddings run on CPU, no per-request embedding
  cost, no data leaves the box for the routing decision itself.
- **Per-conversation ratchet** — sticky, upgrade-only model pinning keyed by
  conversation id; survives restarts (state persisted to disk, 14-day TTL).
- **Confidence + margin fallback** — weak or near-tie classifications fall back
  to the cheapest route instead of escalating on a coin-flip.
- **Vision clamp** — turns carrying images are routed to a vision-capable model
  automatically.
- **Streaming** — SSE passes straight through the proxy.
- **Observability** — `GET /stats` shows what your users actually ask for
  (route/model usage counts); decisions are logged, message content never is.
- **Safe by default** — binds loopback only; refuses to bind a public interface
  without a token; constant-time auth; 1 MB request cap.
- **Zero native deps** — pure JS/WASM embedding runtime and a JSON state file
  (no `node-gyp`, no sqlite build).

## Compatibility

**Client side — OpenAI Chat Completions API.** Anything that speaks the OpenAI
`/v1/chat/completions` schema works by pointing its base URL at Tarot Club and
using model `arcana`:

- `openai` (Python), `openai` (Node), and their drop-in forks
- LangChain, LlamaIndex, Vercel AI SDK, and similar (set the base URL / model)
- `curl`, `httpx`, `fetch`, etc.

Supported request features: `messages` (string **or** multi-part content),
`stream` (SSE), and any other OpenRouter-accepted fields (`tools`,
`temperature`, `provider`, …) — the body is forwarded as-is with only the
`model` field replaced. Plus one extension: `conversation_id` in the body or an
`X-Conversation-Id` header to drive the ratchet.

> **Scope:** only `POST /v1/chat/completions` is implemented. There is no
> `/v1/models`, `/v1/completions`, or `/v1/embeddings`. Routing reads the latest
> user message's text (and whether it has images); it does not parse tool call
> arguments.

**Provider side — OpenRouter.** The proxy forwards to
`https://openrouter.ai/api/v1/chat/completions`. Any model slug available on
OpenRouter can be a route target — edit `src/routes.ts`. (Decide-only mode is
provider-agnostic: it just returns a slug; call whatever you like.)

**Runtime.** Node.js **20+** (uses global `fetch` and `Readable.fromWeb`);
developed and tested on Node 22. TypeScript runs directly via `tsx` — no build
step. Cross-platform (Linux/macOS/Windows); the embedder is CPU-only WASM, no
GPU required. First run downloads `Xenova/all-MiniLM-L6-v2` (~22 MB) from the
Hugging Face Hub and caches it locally.

## Quick start

```bash
git clone https://github.com/jzhao234/tarot-club
cd tarot-club
npm install
cp .env.example .env        # add your OpenRouter key
```

**A) Proxy mode (one key, drop-in).**

```bash
OPENROUTER_API_KEY=sk-or-... npm start
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8090/v1", api_key="unused")
r = client.chat.completions.create(
    model="arcana",
    messages=[{"role": "user", "content": "refactor this python function"}],
    extra_headers={"X-Conversation-Id": "thread-42"},  # enables the ratchet
)
print(r.choices[0].message.content)
# the response's X-Arcana-Model header tells you which real model answered
```

**B) Decide-only (no key, you call the provider).**

```bash
curl -s localhost:8090/route \
  -d '{"conversation_id":"t1","message":"refactor this"}'
# -> {"model":"z-ai/glm-5.2","route":"coding","tier":"The Hermit",
#     "score":0.6,"margin":0.2,"source":"semantic","sticky":false}
```

## Routes

Defaults map three intent categories to public OpenRouter slugs. Swap any of
them in [`src/routes.ts`](src/routes.ts):

| Route     | Tier (label)  | Default model               | Rank | Vision | For                                          |
|-----------|---------------|-----------------------------|:----:|:------:|----------------------------------------------|
| `general` | The Magician  | `google/gemini-3.5-flash`   |  0   |   ✓    | everyday Q&A, summaries, rewrites, lookups   |
| `coding`  | The Hermit    | `z-ai/glm-5.2`              |  1   |   ✗    | code, debugging, tests, CI, SQL              |
| `heavy`   | The Fool      | `anthropic/claude-opus-4.8` |  2   |   ✓    | client-facing, complex, or high-stakes work  |

The `route` id drives logic; **Tier** is a cosmetic tarot-themed label shown in
logs / `/tiers` / `/route` (rename freely in `src/routes.ts`). `rank` is the
capability/cost order the ratchet climbs; the conversation never
drops below the highest rank it has used.

## How routing works

For each turn:

1. **Classify by meaning.** Embed the query, score it (top-3-pooled cosine)
   against each route's example cluster, take the highest.
2. **Fallback guard.** If the top score is below `MIN_CONFIDENCE` *or* the gap
   to the runner-up is below `MIN_MARGIN` (a near-tie), fall back to the
   `general` route rather than escalate on a guess.
3. **Ratchet.** Never pick a model below the conversation's floor rank — use the
   more capable of (this turn's intent, the conversation's high-water mark).
4. **Vision clamp.** If the turn has images and the chosen model can't see them,
   escalate to the cheapest vision-capable route at or above the current rank.

Full details and the caching rationale are in
[`docs/architecture.md`](docs/architecture.md).

## API

| Method & path                | Auth\* | Needs key | Purpose                                              |
|------------------------------|:------:|:---------:|------------------------------------------------------|
| `POST /v1/chat/completions`  |   ✓    |    yes    | OpenAI-compatible proxy: route, forward, stream back |
| `POST /route`                |   ✓    |    no     | Return the chosen model slug; you call the provider  |
| `GET /tiers`                 |  open  |    no     | The virtual model and its routes                     |
| `GET /stats`                 |   ✓    |    no     | Route/model usage counts                             |
| `GET /healthz`               |  open  |    no     | Liveness                                             |

\* Auth applies only when `ARCANA_API_TOKEN` is set. The proxy returns `501` if
`OPENROUTER_API_KEY` is unset. Full request/response schemas, headers, and
status codes: [`docs/api.md`](docs/api.md).

## Configuration

| Var                  | Default                  | Meaning                                                   |
|----------------------|--------------------------|-----------------------------------------------------------|
| `OPENROUTER_API_KEY` | _(unset)_                | enables the `/v1/chat/completions` proxy                  |
| `ARCANA_ADDR`        | `127.0.0.1:8090`         | listen address (also `ARCANA_HOST` / `ARCANA_PORT`)       |
| `ARCANA_API_TOKEN`   | _(unset)_                | when set, protected endpoints require it                  |
| `ARCANA_STATE_FILE`  | `data/arcana-state.json` | ratchet + stats persistence (set `""` for in-memory)      |

If you bind a non-loopback address you **must** set `ARCANA_API_TOKEN` — the
server refuses to start otherwise. Routing knobs (the tier→model map, example
phrases, `MIN_CONFIDENCE`, `MIN_MARGIN`) live in `src/routes.ts`. See
[`docs/configuration.md`](docs/configuration.md).

## Development & tuning

```bash
npm install
npm test          # vitest — routing, ratchet, store, HTTP API (fast, no model load)
npm run typecheck # tsc --noEmit
npm run eval      # labeled routing accuracy against the real embedding model
npm run dev       # start with auto-reload (tsx watch)
npm start         # load the model, then serve
```

**Tuning** is mostly about the example phrases in `src/routes.ts` — edit them to
match how your users actually phrase things, then `npm run eval`. To tune on
real traffic, dump queries (one per line) and replay them:

```bash
npm run eval -- queries.txt
# prints the route distribution + low-confidence / near-tie rates
```

## Deployment

Run it on loopback next to your app and talk to it over `127.0.0.1`. A sample
`systemd` unit is in [`deploy/arcana.service`](deploy/arcana.service); a Docker
recipe and hardening notes are in [`docs/deployment.md`](docs/deployment.md).

## Project layout

```
src/
  index.ts      entrypoint: parse env, load model, start the server
  server.ts     HTTP API (proxy, /route, /tiers, /stats, /healthz)
  router.ts     classify + resolve (fallback, ratchet, vision clamp)
  routes.ts     the routes, models, example corpus, thresholds  ← tune here
  store.ts      per-conversation pins + usage stats (JSON-persisted)
  embedder.ts   all-MiniLM-L6-v2 via @huggingface/transformers
scripts/
  eval.ts       labeled accuracy gate + real-traffic replay
docs/           architecture, API, configuration, deployment
deploy/         sample systemd unit
```

## FAQ

**Does my message get sent anywhere for routing?** No. The routing decision is
made locally by the embedding model. In proxy mode, the message is then
forwarded to OpenRouter (that's how it gets answered) exactly as any OpenAI
client would.

**Why does it never downgrade within a conversation?** Switching models resets
the provider's prompt cache and drops continuity. The ratchet trades a little
"always optimal per turn" for far fewer cold cache prefills, which is cheaper in
practice. See [`docs/architecture.md`](docs/architecture.md).

**Can I use a provider other than OpenRouter?** In decide-only mode, yes —
`/route` just returns a slug. The bundled proxy targets OpenRouter specifically.

**Can I add or rename routes?** Yes — edit `src/routes.ts` (id, model slug,
rank, vision flag, example phrases), then `npm run eval`.

## License

[MIT](LICENSE).
