# Deploying the all-Cloudflare app (Worker + PWA on D1)

The app is one Cloudflare Worker that serves the React PWA (Static Assets) and the
`/api/*` API against a **D1** (SQLite) database. It deploys from GitHub via the
`deploy` workflow. Nobody hand-edits the database — the schema is code
(`packages/d1/migrations`), applied by the pipeline.

## One-time setup (you, in Cloudflare + GitHub)

1. **Create the D1 database** (once):
   ```
   npx wrangler d1 create sancta
   ```
   Copy the printed `database_id`.
2. **Create a scoped API token** (Cloudflare → My Profile → API Tokens): permissions
   `Workers Scripts:Edit`, `D1:Edit` (and `Workers KV:Edit` if used later). Copy it.
3. **Add repo configuration** (GitHub → Settings → Secrets and variables → Actions):
   - Secret `CLOUDFLARE_API_TOKEN` = the token
   - Secret `CLOUDFLARE_ACCOUNT_ID` = your Cloudflare account id
   - Variable `CLOUDFLARE_D1_DATABASE_ID` = the `database_id` from step 1 (not secret)

## Deploying

Push to `main` (or run the **deploy** workflow manually). The pipeline:
1. builds the PWA,
2. runs `wrangler d1 migrations apply sancta --remote` (forward-only, idempotent),
3. runs `wrangler deploy` — shipping the Worker + assets as one versioned release.

Verify: `GET https://<your-worker-url>/healthz` → `{ "status": "ok", "plane": "cloud", "db": "d1" }`.

## Authentication (do this before real data — Phase D6)

The skeleton currently trusts `x-roles`/`x-user` headers (fine for local dev, NOT
for the public internet). Before exposing real data, put **Cloudflare Access** in
front of the Worker (Zero Trust → Access → add an application for the Worker's
hostname). Access authenticates staff and passes a verified identity header
(`Cf-Access-Authenticated-User-Email`), which `apps/worker/src/auth.ts` already
reads; the remaining work is mapping that identity to roles.

## Local development

Run the Worker locally against a local D1 (no cloud needed):
```
npm run build -w @sancta/clinic-web
cd apps/worker
npx wrangler d1 migrations apply sancta --local
npx wrangler dev
```
Tests run the same handlers against LocalD1 (node:sqlite) with no network:
`npm test -w @sancta/d1` and `npm test -w @sancta/worker`.

## What's live vs. pending

- **Live in the skeleton:** health, `GET /api/patients`, `GET /api/stock`,
  `POST /api/checkout` (the full dispense-and-pay: stock + invoice + payment +
  balanced double-entry ledger, atomic + idempotent) — all on D1, deny-by-default
  RBAC, PWA served as assets.
- **Pending:** the remaining ~248 API handlers are ported into
  `apps/worker/src/routes.ts` in later passes (same auth → handler → D1 shape),
  and Cloudflare Access wiring (D6).
