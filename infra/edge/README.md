# Clinic-edge deployment (structure)

Reproducible install/upgrade/rollback/recovery for the clinic edge hub mini-PC
(pack §12 deliverables, NFR-024/031). Filled with the container image and scripts as the
edge server matures.

## Target

A reliable low-power Linux mini-PC on the clinic LAN running, as containers:

- clinic-web PWA (served locally during outages),
- clinic-edge local API + business-rule service (`@sancta/clinic-edge`),
- local PostgreSQL (canonical operational store),
- encrypted sync outbox/inbox worker,
- local file cache, print/receipt queue, backup agent, health monitor.

## Principles

- **Offline-first:** the hub authenticates provisioned users, saves transactions, prints,
  closes the cashier and queues sync for ≥72 h with no internet (NFR-001/038).
- **Power resilience:** UPS for hub/network/receipt printer; graceful shutdown; automatic
  recovery without manual database repair (NFR-031); routine restore rehearsal.
- **No exposure:** local PostgreSQL and the edge API are never exposed to the public
  internet; remote support is outbound-only via optional Cloudflare Tunnel (CLD-010).

## Planned artefacts

- `docker-compose.yml` (or systemd + Podman) for the hub services.
- `install.sh`, `upgrade.sh`, `rollback.sh`, `restore.sh` with versioned DB migrations.
- provisioning of first device trust + first user activation (online-required step).

## No secrets or PHI

Installer reads secrets from a secure store at deploy time; none are committed. No
production patient data is copied into any non-production hub (ADM-007).
