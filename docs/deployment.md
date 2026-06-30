# Deployment

Tarot Club is a single long-running Node process. Run it on **loopback** next to
the app that uses it and talk to it over `127.0.0.1`. If you must expose it,
bind a real interface *and* set `ARCANA_API_TOKEN` (the server refuses
non-loopback binds without one).

## Prerequisites

- Node.js 20+ (developed/tested on 22).
- An OpenRouter API key (only if you want the `/v1` proxy).
- Outbound network to the Hugging Face Hub on first run (downloads the ~22 MB
  embedding model, then caches it) and to OpenRouter (proxy mode).

## Run it directly

```bash
npm install
OPENROUTER_API_KEY=sk-or-... npm start
```

The process loads the embedding model and precomputes the route corpus *before*
it starts listening, so a successful `GET /healthz` means it's ready to route.

## systemd

A sample unit is in [`../deploy/arcana.service`](../deploy/arcana.service). It
runs on loopback, reads secrets from an `EnvironmentFile`, and applies basic
hardening. Adjust `WorkingDirectory`, `User`, and the env file path, then:

```bash
sudo cp deploy/arcana.service /etc/systemd/system/
sudoedit /etc/systemd/system/arcana.env     # OPENROUTER_API_KEY=..., ARCANA_*
sudo systemctl daemon-reload
sudo systemctl enable --now arcana
journalctl -u arcana -f
```

Keep the env file `chmod 600` and owned by the service user — it holds the
OpenRouter key. Point `ARCANA_STATE_FILE` at a writable directory the service
user owns (e.g. under `WorkingDirectory/data`).

## Docker

There's no bundled image, but it's a standard Node service. A minimal Dockerfile:

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ENV ARCANA_ADDR=0.0.0.0:8090 \
    ARCANA_STATE_FILE=/data/arcana-state.json
VOLUME /data
EXPOSE 8090
CMD ["npm", "start"]
```

```bash
docker build -t tarot-club .
docker run --rm -p 127.0.0.1:8090:8090 \
  -e OPENROUTER_API_KEY=sk-or-... \
  -e ARCANA_API_TOKEN=$(openssl rand -hex 32) \
  -v tarot-club-data:/data \
  tarot-club
```

Because the container binds `0.0.0.0` internally, set `ARCANA_API_TOKEN`. Map
the port to `127.0.0.1` on the host (as above) unless you genuinely want it
reachable, and mount a volume at `/data` so ratchet pins survive restarts. The
embedding model downloads on first start; bake it into the image or mount a
cache volume if cold starts matter.

## Operational notes

- **State** persists to `ARCANA_STATE_FILE` (atomic writes, flushed on
  `SIGINT`/`SIGTERM`). Back it up if you care about ratchet continuity across
  hosts; it's safe to lose (conversations just re-route fresh). Pins idle >14
  days are evicted automatically.
- **Health check:** `GET /healthz` → `200 ok`.
- **Metrics:** `GET /stats` (auth) for route/model usage counts.
- **Logs** carry the routing decision and message length, never message content.
- **Timeouts** are tightened on the HTTP server; a stuck client can't hold a
  connection open indefinitely.

## Security checklist

- [ ] Loopback-only, or a token set if exposed.
- [ ] `ARCANA_API_TOKEN` is a long random secret, not committed.
- [ ] The env/secret file is `chmod 600` and git-ignored (`.env` already is).
- [ ] `OPENROUTER_API_KEY` is provided via env/secret file, never hard-coded.
- [ ] The state file lives on a volume/dir the service user owns.
