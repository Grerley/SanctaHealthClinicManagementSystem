# Edge API contract

`openapi.json` is the versioned contract for the clinic edge API (system of
record). It is the reviewable source of truth for the route surface and the
deny-by-default permission each route enforces (`x-permission`).

## How it stays honest (SYN-009, pack §22)

`scripts/contract-check.ts` runs in CI (build-test job) and fails the build on any
drift between this document and the implementation:

1. every implemented `/api` route is documented (no undocumented endpoint);
2. every documented operation is implemented (no phantom documentation);
3. each operation's `x-permission` matches the permission the server actually
   enforces (`requiredPermission` in `apps/clinic-edge/src/http-auth.ts`);
4. the document is a structurally valid OpenAPI 3.x spec.

## Workflow

- After adding or changing a route, refresh the contract: `npm run openapi:gen`.
  This preserves hand-authored summaries/descriptions/request bodies (merged by
  `operationId`) and only updates the route/permission surface.
- Review the diff, commit it with the code change.
- CI runs `npm run contract` to enforce agreement.

The FHIR-compatible interoperability layer (the remaining half of SYN-009) is a
later phase; this covers the versioned REST contract and its contract tests.
