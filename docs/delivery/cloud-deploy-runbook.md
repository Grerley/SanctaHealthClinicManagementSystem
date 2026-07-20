# Cloud deployment runbook (Cloudflare)

This is the exact, ordered procedure to deploy the cloud-enhancement plane. It is
short and deterministic because the code, IaC and migrations are already in place
and CI-tested; the steps below are the parts that require a live account and the
B2/B3 governance sign-offs (data residency, tenancy — see
`docs/governance/decision-signoff-pack.md`).

The clinic **edge** plane (system of record) does not depend on any of this — it
runs offline-first on local PostgreSQL. The cloud plane is an enhancement.

## Prerequisites (human-provided, one-time)

1. **B2/B3 decisions** — approved jurisdiction and Cloudflare tenancy. This fixes
   the R2/Hyperdrive region and the `env.production` target.
2. **Scoped API token** — a Cloudflare API token with least privilege:
   `Account · Workers Scripts:Edit`, `Account · Workers R2 Storage:Edit`,
   `Account · Hyperdrive:Edit`, `Account · Workers KV Storage:Edit` (only those
   actually used). Store it as `CLOUDFLARE_API_TOKEN` in the deploy environment —
   never in the repo (the `iac` and `secret-scan` gates enforce this).
3. **Managed PostgreSQL** — a reachable managed PostgreSQL 16 instance in the
   approved jurisdiction (the canonical cloud store, CLD-004). Capture its
   connection string as a secret.
4. **Enable R2** in the Cloudflare dashboard (one click; required before buckets
   can be created — CLD-006).

## Step 1 — Cloud database schema

Apply the forward-only migrations to the managed PostgreSQL (same SQL the edge
uses; `allMigrationsSql()` concatenates 0001…latest in order):

```bash
psql "$CLOUD_DATABASE_URL" -f <(node --experimental-strip-types -e \
  "import('@sancta/db/migrations').then(m=>process.stdout.write(m.allMigrationsSql()))")
# The cloud store holds NO synthetic seed and NO patient data until real sync.
```

## Step 2 — Hyperdrive (CLD-004/005)

Create a cache-disabled Hyperdrive config over the managed PostgreSQL and bind it:

```bash
npx wrangler hyperdrive create sancta-pg-production \
  --connection-string "$CLOUD_DATABASE_URL" --caching-disabled
```

Then uncomment the `[[hyperdrive]]` block in `apps/cloud-worker/wrangler.toml`
and set `id` to the returned config id. (Or apply `infra/cloudflare/main.tf` with
`terraform apply -var environment=production`.)

## Step 3 — R2 buckets (CLD-006)

```bash
npx wrangler r2 bucket create sancta-documents-production
npx wrangler r2 bucket create sancta-reports-production
npx wrangler r2 bucket create sancta-backups-production
```

Uncomment the `[[r2_buckets]]` binding in `wrangler.toml`.

## Step 4 — Queues (CLD-003, already tested at the edge)

```bash
npx wrangler queues create sancta-sync-apply-production
npx wrangler queues create sancta-sync-apply-dlq-production
```

Uncomment the `[[queues.*]]` blocks (consumer `max_retries = 5`,
`dead_letter_queue` set) in `wrangler.toml`.

## Step 5 — Build the PWA and deploy the Worker + Static Assets (CLD-001/002)

```bash
npm run build -w @sancta/clinic-web            # emits apps/clinic-web/dist
npx wrangler deploy --env production            # ships Worker + [assets] as one unit
```

The `[assets]` binding serves the PWA/portal from the same versioned Worker
release (Workers Static Assets, not the deprecated Sites pattern).

## Step 6 — Secrets (never committed)

```bash
echo "$CLOUD_DATABASE_URL" | npx wrangler secret put DATABASE_URL --env production
# plus any signing keys / integration credentials, one per `wrangler secret put`
```

## Step 7 — Post-deploy verification

- `GET https://<worker>/healthz` → `{ status: "ok", plane: "cloud" }`.
- Point an edge instance's `CLOUD_INGRESS_URL` at the Worker; run a real
  offline→reconnect sync; confirm the cloud reconciles and a re-push is idempotent
  (the same assertions the Node-adapter integration tests already prove).
- Run a **load** test against the ingress and a **security** scan of the deployed
  configuration (TLS 1.2+, cache-disabled protected paths, no PHI in logs) to
  close CLD-002 load/security and NFR-015.
- Verify a restore of the managed PostgreSQL from an R2-stored backup (CLD-004
  restore, UAT-16 in the cloud).

## What this closes

Completing this runbook moves the deploy-gated partials
(CLD-001, CLD-002, CLD-004, NFR-015; see `partials-disposition.md`) from
`partial` to `built`, with the live verification evidence recorded in
`verification-evidence.md`.

## Access note (as observed during this build)

The Cloudflare MCP integration available to the build agent is **read-only for
Workers** (list/get/get-code) and cannot deploy; `wrangler` is installed but had
no `CLOUDFLARE_API_TOKEN` in the environment; R2 was not yet enabled on the
account. Deployment therefore requires the human-provided prerequisites above —
it is not a code gap.
