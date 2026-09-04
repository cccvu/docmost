# Authorization integration contract

This directory is the canonical, published contract for integrating this Docmost fork with an external
authorization and audit service. It is what the code means when it points you at
`docs/integrations/authorization` (see `apps/server/src/authz/port/remote-authz-client.port.ts`).

There are two specs, one per direction:

| Spec | Direction | Who implements it | Audience |
| --- | --- | --- | --- |
| [`authorization-service.openapi.json`](./authorization-service.openapi.json) | fork calls OUT | you (a third party) | run the fork in `AUTHZ_MODE=remote` against your own authorization service |
| [`service-bridge.openapi.json`](./service-bridge.openapi.json) | fork is called IN | this fork (already built) | an integrating platform that provisions shadow users and mints sessions |

If you only want to run the fork standalone with its own authorization, you do NOT need either spec: use
`AUTHZ_MODE=native` (see [`../../architecture/standalone.md`](../../architecture/standalone.md)). These specs
matter only for `AUTHZ_MODE=remote`.

## The outbound contract (implement this to run remote)

`authorization-service.openapi.json` describes six `POST` endpoints your service must expose:

- `/authz/check` -> `{ allowed }`
- `/authz/check-bulk` (<= 256 checks) -> `{ results }` (one boolean per check, in order)
- `/authz/filter-resources` (<= 1000 candidateIds) -> `{ ids }` (the authorized subset)
- `/authz/lookup-resources` -> `{ ids }` (the full authorized set)
- `/authz/filter-subjects` (<= 1000 candidates) -> `{ subjects }` (passing subjects, echoed verbatim)
- `/audit/ingest` (<= 500 events) -> `202 { accepted, persisted }` (fire-and-forget on the fork side)

Point the fork at your service with two environment variables:

```
AUTHZ_MODE=remote
PLATFORM_AUTHZ_URL=https://your-authz-service.example      # base URL, no path prefix
PLATFORM_AUTHZ_SERVICE_SECRET=<a shared secret, >= 16 chars>
# optional: PLATFORM_AUTHZ_TIMEOUT_MS=1500  (clamped to [250, 60000])
```

### Rules you cannot violate

- **Authenticate every request** by comparing the `x-authz-service-secret` header to your configured secret in
  constant time. Missing/wrong secret: `401`. Secret not configured on your side: `503`.
- **Respond within the timeout** (`PLATFORM_AUTHZ_TIMEOUT_MS`, default 1500 ms). The fork uses an
  `AbortController`; a slow response is treated as a denial.
- **The fork fails closed.** If your service is unreachable, times out, returns a non-2xx, or returns a
  malformed body, the fork denies (`check` -> false, the list endpoints -> empty). It NEVER falls back to
  native decisions. So returning `5xx` on your own errors is safe: it degrades to deny, never to allow.
- **Subjects arrive as** `{ "provider": "docmost", "externalId": "<docmost user id>" }`. The `{ principalId }`
  shape is in the schema for completeness but this fork does not send it.
- The reference implementation also rejects unknown request keys with `400` and enforces the array caps; the
  fork never sends unknown keys or over-cap arrays, so a faithful implementation is strict but never triggers
  those paths in normal operation.

### Reference stub

A zero-dependency Node reference implementation lives at
[`../../../examples/integrations/authorization-stub/`](../../../examples/integrations/authorization-stub/).
It implements all six endpoints faithfully (secret check, caps, status codes, subject shape) with a
deterministic, **deny-by-default** demo policy. Use it to see the wire shapes and to smoke-test the fork in
remote mode without building a real PDP. It is a skeleton, not a production authorization service.

## The inbound contract (what the fork exposes)

`service-bridge.openapi.json` describes the east-west endpoints the fork hosts for an integrating platform.
You only implement a *caller* for these; the fork is the server. They fall into a few families:

- **Session brokerage** (`service-bridge`): `POST /api/service/users` (provision a shadow user),
  `POST /api/service/users/resolve` (Docmost user id -> workspace), `POST /api/service/session` (mint a
  session).
- **Workspace** (`workspace`): `GET /api/service/workspace/default` (the canonical workspace id),
  `GET`/`PATCH /api/service/workspace/settings`.
- **Space control plane** (`spaces`): `GET`/`POST /api/service/spaces`, `GET`/`PATCH
  /api/service/spaces/{id}`, `POST .../archive` and `.../unarchive`, and `GET`/`POST`/`PATCH`/`DELETE` on
  `.../spaces/{id}/members`.
- **Content read model** (`pages`, `content`): `POST /api/service/pages/resolve-space`,
  `GET /api/service/pages/{id}/permissions`, `POST /api/service/content/pages/list`,
  `POST /api/service/content/spaces/list`, `GET /api/service/content/spaces/{id}`.
- **Change feed** (`changes`): `GET /api/service/authz/changes` (long-poll for membership/page/restriction
  change events after an opaque cursor) and `GET /api/service/authz/snapshot` (the full desired set,
  paginated, for drift repair). The fork owns a transactional outbox (an AFTER trigger writes a change row
  inside Docmost's own write transaction, so capture is atomic + at-least-once) and emits TYPED domain events;
  the platform projects them into its PDP and owns the Docmost-user -> principal identity mapping. Delivery is
  COMMIT-SAFE and gap-free: the feed serves a row only once its inserting transaction is fully settled
  (ordered + cursored by `(xact_id, id)` under an `xact_id < pg_snapshot_xmin` gate; `xact_id` is the
  non-wrapping `xid8`), so the classic transactional-outbox skip cannot occur, and the cursor is opaque (the
  event `seq` is diagnostic only). This requires PostgreSQL 13+ (the installer fails the boot in remote mode
  otherwise). The durable outbox is the source of truth (LISTEN/NOTIFY is a wakeup-only latency optimization);
  a cursor at/below the retention high-water mark returns `409 {stale, head}` so the platform rebaselines
  (reconcile, then reset its cursor to the snapshot `baseline`) rather than skipping. This replaces the
  platform reaching directly into Docmost's database, so it needs no Docmost DB credentials.
- **Collab** (`collab`): `POST /api/collab/force-disconnect`.

Three properties bind the whole surface:

- **Mode-gated.** Every route is `404` unless the fork runs `AUTHZ_MODE=remote` (RemoteOnlyGuard, checked
  before the secret). In native mode there is no integrating platform and the surface does not exist.
- **Scoped + secret-gated.** Every request carries `x-authz-service-secret`; each `/api/service/*` route
  requires exactly one least-privilege scope (`session:mint`, `users:provision`, `users:resolve`,
  `workspace:read`, `workspace:settings:write`, `spaces:read`, `spaces:write`, `pages:read`, `content:read`,
  `changes:read`).
- **The platform is the authorization authority.** Identity-mutating endpoints are keyed only on an opaque
  `externalId` (no arbitrary-identity selection). The `content/*` read endpoints are a **privileged data
  plane, not a second gate**: the platform performs the PDP decision first and passes the authorized id set;
  the fork returns metadata for exactly those ids and does NOT re-authorize.

## Source of truth

These two specs are the single source of truth for the request/response shapes and the array caps. The fork's
consumer contract test and the reference platform's provider contract test both derive their canonical bodies
and caps from `authorization-service.openapi.json`; a drift between the code and this contract fails a test.
They supersede the retired `contract/pep-pdp.contract.json` fixture.
