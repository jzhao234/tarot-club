# API reference

Base URL defaults to `http://127.0.0.1:8090`. All bodies are JSON; the max
request size is **1 MB** (larger → `413`).

## Authentication

When `ARCANA_API_TOKEN` is set, the **protected** endpoints
(`POST /v1/chat/completions`, `POST /route`, `GET /stats`) require it via either
header:

```
Authorization: Bearer <token>
X-Arcana-Token: <token>
```

`GET /tiers` and `GET /healthz` are always open. When the token is unset, every
endpoint is open (only do this on loopback — the server refuses to bind a
non-loopback host without a token).

---

## `POST /v1/chat/completions`

OpenAI-compatible proxy. Tarot Club routes the turn, forwards the request to
OpenRouter with your `OPENROUTER_API_KEY`, and streams the response back.
Requires the key — without it this endpoint returns `501`.

**Request.** The standard OpenAI Chat Completions body. The whole body is
forwarded to OpenRouter with only `model` replaced, so any OpenRouter-accepted
field (`temperature`, `tools`, `stream`, `provider`, …) passes through.

| Field             | Type                | Notes                                                              |
|-------------------|---------------------|--------------------------------------------------------------------|
| `model`           | string              | Use `"arcana"`. Replaced with the chosen real slug before forwarding. |
| `messages`        | array (required)    | Each `content` may be a string or an array of parts (`{type:"text"}`, `{type:"image_url"}`). |
| `stream`          | boolean             | `true` streams SSE straight through.                               |
| `conversation_id` | string (extension)  | Drives the ratchet. Stripped before forwarding. May also be sent as the `X-Conversation-Id` header. |
| _other_           | any                 | Forwarded unchanged.                                               |

Routing reads the **latest user message**: its text, and whether it contains any
image part (which can trigger the vision clamp).

**Response.** Whatever OpenRouter returns (status, body, content-type), plus
these headers describing the decision:

| Header            | Example                       |
|-------------------|-------------------------------|
| `X-Arcana-Model`  | `z-ai/glm-5.2`                |
| `X-Arcana-Route`  | `coding`                      |
| `X-Arcana-Source` | `semantic` \| `fallback` \| `ratchet` \| `vision` |

**Status codes:** `200` (proxied; or upstream's own status), `400` (no
`messages[]` / invalid JSON), `401` (bad token), `413` (body too large), `501`
(`OPENROUTER_API_KEY` unset), `502` (upstream request failed).

**Example**

```bash
curl -N http://127.0.0.1:8090/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'X-Conversation-Id: thread-42' \
  -d '{
        "model": "arcana",
        "stream": true,
        "messages": [{"role": "user", "content": "write a python function to parse a csv"}]
      }'
```

---

## `POST /route`

Decide the model for a turn **without** proxying. No OpenRouter key needed —
useful when you want to call the provider yourself, or just observe routing.

**Request**

| Field             | Type            | Notes                                              |
|-------------------|-----------------|----------------------------------------------------|
| `message`         | string (required) | The user text to route on. Empty/blank → `400`.  |
| `conversation_id` | string          | Optional. Enables the ratchet (high-water mark).   |
| `has_images`      | boolean         | Optional. `true` triggers the vision clamp.        |

**Response**

```json
{
  "model":  "z-ai/glm-5.2",
  "route":  "coding",
  "tier":   "The Hermit",
  "score":  0.61,
  "margin": 0.23,
  "source": "semantic",
  "sticky": false
}
```

| Field    | Meaning                                                                 |
|----------|-------------------------------------------------------------------------|
| `model`  | The real model slug to use.                                             |
| `route`  | The semantic intent matched (reported even if ratchet/vision changed the model). |
| `tier`   | Themed display label of the chosen route (cosmetic).                    |
| `score`  | Top-3-pooled cosine of the winning route (confidence).                  |
| `margin` | `top1 − top2` score gap (ambiguity; small = near-tie).                  |
| `source` | `semantic` \| `fallback` \| `ratchet` \| `vision`.                      |
| `sticky` | `true` when the choice came from the conversation ratchet.              |

**Status codes:** `200`, `400` (missing/blank `message` or invalid JSON), `401`,
`413`.

---

## `GET /tiers`

The virtual model and its routes. Open (no auth).

```json
{
  "model": "arcana",
  "routes": [
    {"route": "general", "tier": "The Magician", "model": "google/gemini-3.5-flash",  "rank": 0, "vision": true,  "examples": 20},
    {"route": "coding",  "tier": "The Hermit",   "model": "z-ai/glm-5.2",             "rank": 1, "vision": false, "examples": 25},
    {"route": "heavy",   "tier": "The Fool",     "model": "anthropic/claude-opus-4.8","rank": 2, "vision": true,  "examples": 20}
  ]
}
```

---

## `GET /stats`

Aggregate usage — "what people use it for." Protected (auth when a token is set).

```json
{
  "startedAt": 1730000000000,
  "totalRoutes": 142,
  "activeConversations": 9,
  "byRoute": {"general": 80, "coding": 50, "heavy": 12},
  "byModel": {"google/gemini-3.5-flash": 80, "z-ai/glm-5.2": 50, "anthropic/claude-opus-4.8": 12}
}
```

`activeConversations` is the number of non-expired ratchet pins. Timestamps are
epoch milliseconds.

---

## `GET /healthz`

Liveness. Open. Returns `200 ok` (plain text) once the server is listening (the
embedding model is already loaded by then — the process doesn't start listening
until `router.init()` succeeds).
