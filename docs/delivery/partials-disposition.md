# Remaining partials — disposition

As of this branch, all backlog partials that can be **honestly verified without a
live Cloudflare account** have been closed to `built` with passing tests (see
`verification-evidence.md`). Four items remain `partial`. They are not left
undone by oversight — each is genuinely gated on a live cloud deployment and on
the human-owned blocking decisions **B2 (data residency/jurisdiction)** and **B3
(cloud account + tenancy)** in `docs/governance/decision-signoff-pack.md`. Marking
them `built` would misrepresent unverified deployment work as tested.

| ID | Requirement | What IS done (tested) | What remains (gated) |
|----|-------------|-----------------------|----------------------|
| **CLD-001** | PWA + portal via Workers Static Assets + versioned Worker | PWA builds; `wrangler.toml` declares the `[assets]` Static-Assets binding + isolated `env.staging`/`env.production`; IaC-integrity gate passes | `wrangler deploy` to a real account; a live smoke/deploy test |
| **CLD-002** | Cloud API / sync ingress / integration gateway in Workers | The gateway logic is implemented (`apps/cloud-worker/src/{index,sync-ingress,http}.ts`) and exercised by 7 unit tests + edge↔cloud integration tests through the Node adapter (same applier code path); idempotent, returns durable receipts | Deploy to Workers; **load** + **security** testing against the live endpoint |
| **CLD-004** | Managed PostgreSQL as canonical cloud store via Hyperdrive | The canonical cloud store runs on **real PostgreSQL** in integration tests; backup/restore proven (UAT-16); `main.tf` + `wrangler.toml` declare the Hyperdrive binding (connection string as a sensitive variable) | Provision Hyperdrive against managed PostgreSQL; live integration + restore |
| **NFR-015** | Encryption in transit (TLS 1.2+) and at rest (PostgreSQL, R2, backups) | Design fixed: TLS to the Worker, cache-disabled protected paths (CLD-011 tested), R2/PG/backup encryption declared in IaC; secret-scan + IaC gates keep credentials out of code | Enable TLS termination + at-rest encryption on the live infrastructure; verify with a deployed configuration scan |

## Why these are the honest boundary

The edge plane — the clinic's system of record — is complete and tested on real
PostgreSQL end to end. Everything above concerns the **cloud enhancement plane**,
whose verification requires (a) a real Cloudflare account provisioned under an
approved jurisdiction, and (b) the B2/B3 sign-offs that authorise it. The code,
infrastructure-as-code, and Node-adapter tests are in place so that, once those
decisions land, deployment and live verification are a short, deterministic step —
not new development.

Every claim of "built" in `coverage.json` is backed by an automated test that runs
in CI today. These four remain `partial` precisely to keep that guarantee true.
