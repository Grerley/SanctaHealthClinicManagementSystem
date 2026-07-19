# @sancta/clinic-web (planned)

React + Vite progressive web application (ADR-0002). Served by the **clinic edge hub**
during internet outages and by **Cloudflare Workers Static Assets** when connected
(CLD-001). Builds to `dist/`, which `apps/cloud-worker/wrangler.toml` ships with the Worker
as one release unit.

Not yet scaffolded — it lands with the vertical slice (pack §14 step 3,
`docs/delivery/vertical-slice.md`). Requirements it must meet from day one:

- **Offline shell**: cache versioned app shell + offline help (SYN-001); local commit is
  the success condition — never wait on the cloud (pack §12.1).
- **Accessibility**: WCAG 2.2 AA — visible focus, logical tab order, 44px touch targets,
  semantic labels, sufficient contrast, error recovery (NFR-019).
- **Localisation**: British English, externalised strings, DD/MM/YYYY, USD base, local
  time zone (NFR-020).
- **Connectivity states**: always show local save state, last successful sync, pending and
  failed items; never label a local commit as failed because cloud ack is pending (§12.1).
- **Privacy**: mask sensitive values in shared spaces; privacy screen mode; no PHI in URLs
  or notifications (pack §12.1, APT-009).
