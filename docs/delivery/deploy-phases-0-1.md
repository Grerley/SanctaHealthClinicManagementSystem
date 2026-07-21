# Deploy guide — Phase 0 (cloud-first) and Phase 1 (local edge)

This is the operator's guide to running the app two ways. Both use the **same
image and the same database schema** — the only difference is *where* the
PostgreSQL lives and whether the machine needs to be online.

The app is one server that serves **both the API and the web UI** against a
PostgreSQL given by `DATABASE_URL`. On boot it applies pending migrations
(idempotent) and then serves.

Key commands (all from the repo root):

| Command | What it does |
|---------|--------------|
| `DATABASE_URL=… npm run db:migrate` | Apply pending migrations to that database (safe to repeat). |
| `DATABASE_URL=… npm run db:seed` | Load **synthetic demo data** — refuses if `INSTANCE_MODE=production`. |
| `DATABASE_URL=… WEB_DIST=apps/clinic-web/dist npm start` | Start the server (build the PWA first with `npm run build -w @sancta/clinic-web`). |
| `docker compose up -d` | Phase 1: bring up Postgres + the server locally in one command. |

Environment variables the server reads:

| Var | Meaning | Default |
|-----|---------|---------|
| `DATABASE_URL` | The PostgreSQL to use (system of record) | — (no DB → API returns 503) |
| `PORT` / `EDGE_PORT` | Port to listen on (`PORT` is what most cloud hosts inject) | `8787` |
| `WEB_DIST` | Path to the built PWA to serve | unset (API only) |
| `CLOUD_INGRESS_URL` | Where this instance syncs up to (optional) | none |
| `SITE_ID` | This site's id | the default site |
| `INSTANCE_MODE` | `production` marks it real; anything else is non-production and shows a banner | non-production |

---

## Phase 0 — cloud-first (any device logs in; online-only)

Run the server on an always-on host against a **managed PostgreSQL**. Every device
(including your phone) is just a browser pointed at the URL — no local database.
A device with no internet cannot work in this mode; that is the trade-off.

1. **Provision a managed PostgreSQL 16** (Neon, Supabase, RDS, Crunchy, …) in your
   chosen region. Capture its connection string as a secret.
2. **Deploy the server.** Any Node-capable host works (Render, Fly.io, Railway, a
   VM). The included `Dockerfile` builds and runs it:
   ```
   docker build -t sancta-edge .
   # then run it on your host with the env below
   ```
   Set on the host (as secrets/vars, never in the repo):
   ```
   DATABASE_URL=postgres://…         # the managed Postgres
   INSTANCE_MODE=production          # real instance
   # PORT is injected by the platform; WEB_DIST is baked into the image
   ```
   On boot the container runs `db:migrate` then serves. `GET /healthz` confirms it.
3. **Put Cloudflare in front (optional but recommended):** point a Cloudflare-proxied
   domain at the host for TLS, caching of static assets, and DNS. (This is the
   "Cloudflare-fronted" flavour; a pure Cloudflare-Worker rebuild is a separate,
   larger effort — see the architecture notes.)
4. **Browse to the URL** from any device and use the app.

> Production holds real data that must arrive only via real use/sync — never run
> `db:seed` against it (the seed script refuses when `INSTANCE_MODE=production`).

---

## Phase 1 — local edge (your computer is the host; works offline)

Run the server **on a clinic computer** (this can be your laptop) against a
**local PostgreSQL**. It works with no internet. A phone/tablet on the same Wi-Fi
uses it over the LAN. When the machine is online, point `CLOUD_INGRESS_URL` at
your Phase-0 instance to sync up.

**Easiest — one command (Docker):**
```
docker compose up -d
docker compose exec edge npm run db:seed     # optional demo data
```
Then find this computer's LAN address and open it on your phone:
- macOS: `ipconfig getifaddr en0` → e.g. `192.168.1.20`
- Windows: `ipconfig` → the IPv4 address
- open `http://192.168.1.20:8080` on any device on the same Wi-Fi.

**Without Docker (bare):**
```
# 1. a local PostgreSQL running, with a database and DATABASE_URL to it
export DATABASE_URL=postgres://sancta@localhost:5432/sancta
# 2. schema + optional demo data
npm run db:migrate
npm run db:seed
# 3. build the UI and serve
npm run build -w @sancta/clinic-web
WEB_DIST="$PWD/apps/clinic-web/dist" EDGE_PORT=8080 npm start
```

Two things to know for phone testing:
- **Same network required.** The phone must be on the same Wi-Fi as the computer.
  We do not expose the edge to the public internet (that is by design).
- **Full offline PWA install needs HTTPS.** Over a plain `http://<lan-ip>` address
  the app *runs* fine online against the computer, but browsers only enable the
  offline service-worker cache on `https` or `localhost`. For true on-phone
  offline you would front it with HTTPS (a tunnel or a self-signed cert). Not
  needed just to try it.

---

## How they fit together

- **Phase 1** instances (clinic computers) are the offline-capable edges. They
  each hold a local Postgres and keep working through outages.
- **Phase 0** is the shared online instance + managed Postgres they sync up to,
  and the place any thin device logs in when online.
- The **device-local replica for phones** (so a phone works offline without a
  computer on the LAN) is Phase 2 — a separate, larger build; see the
  architecture notes.

## What is validated

The migrate→serve boot sequence is proven against real PostgreSQL: the
forward-migration runner applies all migrations once and is idempotent
(`packages/db/test/migrate-runner.itest.ts`, run in CI), and the server serves the
PWA + API against a freshly-migrated, seeded database. The container image wraps
exactly that sequence.
