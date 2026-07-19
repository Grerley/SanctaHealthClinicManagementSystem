# Architecture diagrams

Context, deployment and trust-boundary views (pack §14 step 4). Rendered with Mermaid.

## 1. Context diagram

Who and what interacts with the system.

```mermaid
graph TB
    subgraph Clinic["Sancta Health Clinic (LAN)"]
        Recep[Receptionist]
        Nurse[Nurse / Triage]
        Doc[Doctor / Prescriber]
        Cash[Cashier]
        Pharm[Pharmacy / Stock]
        Lab[Laboratory user]
    end
    Fin[Finance officer]
    Mgr[Clinic manager]
    Admin[System administrator]
    Aud[Auditor / DPO]
    Outreach[Outreach worker]
    Patient[Patient / Guardian]

    SYS(("Sancta Clinic<br/>Management System"))

    Recep & Nurse & Doc & Cash & Pharm & Lab --> SYS
    Fin & Mgr & Admin & Aud & Outreach --> SYS
    Patient -.assisted / future self-service.-> SYS

    SYS -->|receipt & A4 print| Printer[Local printers]
    SYS -->|queued reminders| SMS[SMS gateway]
    SYS -->|encrypted backup| Backup[Backup destination]
    SYS -->|aggregate extract| DHIS2[DHIS2 / health authority]
    SYS -->|optional| Pay[Mobile-money / payment gateway]
    SYS -->|optional| Payer[Insurer / medical aid]
    SYS -->|FHIR R4 boundary| Ext[External health systems]
```

## 2. Deployment diagram

Offline-first hybrid: clinic edge + Cloudflare cloud plane.

```mermaid
graph TB
    subgraph Edge["Clinic edge hub — mini-PC on clinic LAN (system of record for launch-core work)"]
        direction TB
        EPWA[Local PWA shell<br/>versioned + offline help]
        EAPI[Local API & business-rule service<br/>Node.js modular monolith]
        EDB[(Local PostgreSQL<br/>domain + audit + outbox)]
        Outbox[[Encrypted sync outbox/inbox]]
        FileCache[Local file cache]
        PrintQ[Print & receipt queue]
        BackupA[Backup/restore agent]
        Health[Health monitor + redacted diagnostics]
        EAPI --> EDB
        EAPI --> Outbox
        EAPI --> FileCache
        EAPI --> PrintQ
        BackupA --> EDB
        Health --> EDB
    end

    subgraph Devices["Clinic workstations & tablets"]
        WS[PWA over secured Wi-Fi / Ethernet]
    end
    WS <--> EPWA
    WS <--> EAPI

    subgraph CF["Cloudflare cloud plane (connected / enhancement)"]
        direction TB
        WSA[Workers Static Assets<br/>connected PWA + mgmt portal]
        Worker[Workers: cloud API,<br/>sync ingress, integrations]
        Q[[Queues + dead-letter + replay]]
        HD[Hyperdrive<br/>caching disabled on protected paths]
        Access[Access + WAF + rate limiting]
        DO[Durable Objects<br/>bounded coordination only]
        WSA --> Worker
        Access --> Worker
        Worker --> Q
        Worker --> HD
        Worker -.-> DO
    end

    subgraph CloudData["Cloud data plane"]
        PG[(Managed PostgreSQL<br/>canonical central store)]
        R2[(Private R2<br/>docs, reports, encrypted backups)]
    end
    HD --> PG
    Q --> HD
    Worker --> R2

    Outbox <===>|TLS delta sync,<br/>idempotent, resumable| Worker
    BackupA -.encrypted artefacts.-> R2

    Tunnel{{Cloudflare Tunnel<br/>optional, outbound-only, support only}}
    Tunnel -.-> EAPI

    classDef offline fill:#e6f2ff,stroke:#036;
    classDef cloud fill:#fff2e6,stroke:#a60;
    class Edge,Devices offline;
    class CF,CloudData cloud;
```

**Boundary rule:** internet or Cloudflare loss must not stop authorised LAN work
(NFR-038). The edge hub keeps authenticating provisioned users, saving transactions,
printing, closing the cashier and queuing sync for ≥72 h (NFR-001).

## 3. Trust-boundary diagram

Where identity, encryption and authorisation change hands.

```mermaid
flowchart LR
    subgraph TB1["Trust boundary A — Clinic LAN"]
        User[Provisioned user<br/>+ registered device]
        UserAuth{{Device-bound offline re-auth<br/>RBAC + ABAC, deny-by-default}}
        EdgeSvc[Edge API + PostgreSQL<br/>encrypted at rest]
        User --> UserAuth --> EdgeSvc
    end

    subgraph TB2["Trust boundary B — Public internet / Cloudflare edge"]
        WAF[WAF + rate limiting]
        AccessP[Cloudflare Access<br/>MFA, least privilege]
    end

    subgraph TB3["Trust boundary C — Cloudflare Workers (app plane)"]
        Ingress[Sync ingress<br/>verify device trust, user ctx,<br/>schema, authz, idempotency, deps]
    end

    subgraph TB4["Trust boundary D — Cloud data plane"]
        HDb[Hyperdrive<br/>cache-disabled protected paths]
        PGc[(Managed PostgreSQL<br/>encrypted, PITR)]
        R2c[(Private R2<br/>encrypted, hashed)]
    end

    EdgeSvc ==>|"mutual device trust + TLS<br/>encrypted outbox batches"| WAF
    WAF --> AccessP --> Ingress
    Ingress --> HDb --> PGc
    Ingress --> R2c

    Note1[/"no PHI / identifiers / payloads<br/>in Cloudflare logs, traces, analytics"/]
    Note2[/"no-store on protected responses;<br/>secrets only via Workers Secrets"/]
    Ingress -.-> Note1
    HDb -.-> Note2
```

Boundary controls: unique users, no shared accounts, MFA for privileged/remote access,
offline device-bound re-auth, registered-device trust + revocation + inactivity lock,
break-glass with reason + retrospective review, TLS 1.2+ in transit, strong encryption at
rest everywhere, tamper-evident audit, and PHI kept out of all platform telemetry
(pack §17).
