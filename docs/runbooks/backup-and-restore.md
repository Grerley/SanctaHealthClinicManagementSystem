# Backup & restore runbook (structure)

Serves NFR-011/012/013, UAT-16, pack §17 backups. Filled with concrete commands as the
edge container and cloud database land.

## Objectives

- **Edge RPO = 0** for committed local transactions; cloud RPO bounded by latest sync;
  cloud backup RPO target 15 minutes (NFR-011).
- **RTO**: restore clinic edge from verified backup within **4 hours**; cloud control
  plane within **8 hours** for a declared disaster (NFR-012).
- **Verification**: automated daily backup + successful full restore test at least
  quarterly (NFR-013).

## Edge hub

1. Nightly encrypted `pg_dump`/physical backup to (a) local removable media and (b)
   encrypted R2 backup bucket (CLD-006) — object storage is not the only copy.
2. WAL archiving for point-in-time recovery; UPS enables graceful shutdown (NFR-031).
3. Restore: provision replacement mini-PC, run edge container installer, restore latest
   verified backup + WAL, verify transaction/attachment/user/audit integrity (UAT-16),
   re-register device, resume outbox sync.

## Cloud plane

1. Managed PostgreSQL automated backups + PITR; R2 lifecycle + versioning; independent
   recovery copy retained.
2. Restore: point-in-time restore to target timestamp; re-point Hyperdrive; validate
   read-after-write and reconciliation to edge (NFR-035).

## Evidence

Every restore test records: date, scenario, RPO/RTO achieved, integrity checks, sign-off.
Feeds the MVP operations gate (pack §23.1).
