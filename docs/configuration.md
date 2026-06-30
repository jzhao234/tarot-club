# Configuration

Two kinds of configuration: **environment variables** (runtime/operational) and
the **routes file** (`src/routes.ts`, where the actual routing behavior lives).

## Environment variables

Copy `.env.example` to `.env` and fill it in, or set these in the process
environment (e.g. a systemd unit).

| Var                  | Default                  | Meaning                                                                 |
|----------------------|--------------------------|-------------------------------------------------------------------------|
| `OPENROUTER_API_KEY` | _(unset)_                | Enables the `POST /v1/chat/completions` proxy. The only credential Tarot Club needs. Without it, the proxy returns `501` and only `/route` works. Get one at <https://openrouter.ai/keys>. |
| `ARCANA_ADDR`        | `127.0.0.1:8090`         | Listen address as `host:port`. A colon-less value is treated as a host. |
| `ARCANA_HOST`        | `127.0.0.1`              | Host, if you'd rather set it separately. Takes precedence over `ARCANA_ADDR` when either `ARCANA_HOST` or `ARCANA_PORT` is set. |
| `ARCANA_PORT`        | `8090`                   | Port (same precedence note as `ARCANA_HOST`).                           |
| `ARCANA_API_TOKEN`   | _(unset)_                | Shared secret. When set, `/route`, `/stats`, and `/v1/chat/completions` require it via `Authorization: Bearer <token>` or `X-Arcana-Token: <token>`. **Required** to bind a non-loopback host. |
| `ARCANA_STATE_FILE`  | `data/arcana-state.json` | Where ratchet pins + usage stats persist. Set to `""` to run fully in-memory (state lost on restart). |

**Binding notes.** The host defaults to loopback and is *never* silently
`0.0.0.0`. If you set a non-loopback host without `ARCANA_API_TOKEN`, the server
logs why and exits — an open `/route` would let anyone burn compute and write to
your store.

## The routes file (`src/routes.ts`)

This is where routing behavior is defined. Edit it, then run `npm run eval`.

### Per-route fields

Each entry in `ROUTES` is:

| Field      | Meaning                                                                                  |
|------------|------------------------------------------------------------------------------------------|
| `id`       | Route id (`RouteId`). Reported in `/route`, `/stats`, logs.                               |
| `model`    | The OpenRouter slug to route this category to. **Pin it** (no floating `~` aliases) so prompt-cache pinning and reasoning-signature reconstruction stay stable. |
| `tier`     | Short display name for logs / `/tiers` / the `/route` response.                          |
| `rank`     | Capability/cost order for the ratchet — higher = more capable. A conversation never drops below the highest rank it has used. Keep ranks distinct and ordered cheap→capable. |
| `vision`   | Whether the model accepts image input. Drives the vision clamp.                          |
| `examples` | The phrases that *define* this route. Tuning is mostly editing these.                    |

### Thresholds & default

| Constant         | Default   | Meaning                                                                 |
|------------------|-----------|-------------------------------------------------------------------------|
| `ARCANA_MODEL`   | `"arcana"`| The virtual model name apps point at.                                   |
| `DEFAULT_ROUTE`  | `general` | Low-confidence / near-tie fallback (should be your cheapest route).     |
| `MIN_CONFIDENCE` | `0.25`    | Minimum top-3 cosine for the winner to be trusted. Below → fallback. Real matches usually score ~0.40–0.65. |
| `MIN_MARGIN`     | `0.05`    | Minimum `top1 − top2` gap. A near-tie → fallback instead of escalating on a coin-flip. Conservative so it only catches genuine ties. |

### Changing the models

Swap the `model` slug on any route to any model OpenRouter serves. Keep the
slugs **pinned** to specific versions rather than floating aliases. Re-run
`npm run eval` after any change to confirm the corpus still classifies the
labeled probes correctly.

### Adding or removing a route

Add (or remove) a `RouteDef` with a distinct `rank`, a `vision` flag, and a
cluster of example phrases. Make sure:

- ranks stay ordered cheap→capable and distinct (the ratchet relies on rank
  order);
- `DEFAULT_ROUTE` still points at your cheapest route;
- at least one route at or above each rank is `vision: true` if you expect image
  input (the clamp escalates to the cheapest vision-capable route at or above
  the current rank).

## Tuning the corpus

Routing quality is dominated by how well the example phrases match how your
users actually write. The loop:

1. **Edit** the `examples` in `src/routes.ts`.
2. **Check** with the labeled gate: `npm run eval` (fails if accuracy drops
   below 85%).
3. **Replay real traffic** (optional but best): dump real queries, one per line,
   then `npm run eval -- queries.txt`. It prints the route distribution plus the
   share of low-confidence and near-tie classifications — high rates there mean
   the corpus doesn't cover how people phrase things, so add examples.

Good example phrases are short, varied paraphrases of the same intent with as
little keyword overlap to *other* routes as possible. More distinct examples per
route generally sharpens the top-3-pooled score.
