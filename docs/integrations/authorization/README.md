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

And one OPTIONAL endpoint (1.1.0, #501):

- `/sync/settle` `{ position, timeoutMs }` -> `{ status: "confirmed" | "pending", reason? }`. After a request that
  takes access away succeeds, the fork asks whether every access change up to its outbox position `position` is
  already reflected in your decisions, and reports the answer to its caller as the `Authz-Propagation` response
  header. Answer `confirmed` only when that is true. Positions (like change-feed cursors) order as a pair of
  64-bit integers `(xact_id, id)`, never as strings: `"9.9"` is before `"10.1"`. Without this route (404), every
  such response says `pending`: safe, never a failure. `AUTHZ_NARROWING_SETTLE_TIMEOUT_MS` (default 3000, max 5000, `0` = off) is
  how long the fork lets you wait.

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
  (reconcile, then reset its cursor to the snapshot `baseline`) rather than skipping. A batch whose `dropped` is
  non-zero (1.6.0) advanced past rows that mapped to no event: record it as skipped until a reconcile repairs it. This replaces the
  platform reaching directly into Docmost's database, so it needs no Docmost DB credentials.
  `POST /api/service/authz/pages/state` (1.7.0, scope `pages:authz:read`) serves the CURRENT authorization
  structure of pages — placement, own restriction, and whether the page or any ancestor (trashed ones included) is
  restricted — by id, by subtree or as a full keyset scan, one SQL statement per response. It lets a platform
  project pages level-triggered (re-read what an event names instead of trusting its payload), so a reordered,
  retried or skipped event cannot leave a stale edge.
- **Collab** (`collab`): `POST /api/collab/revalidate` (re-check every live realtime connection after a
  narrowing access change and narrow the ones that lost access, #501; it replaced the per-page
  `force-disconnect` in 1.5.0) and `POST /api/collab/force-disconnect-user` (account disable, #455).

**Access-narrowing propagation (1.6.0, #501).** A successful response from a route that can take access away
(`archive`, the member `POST` upsert, `PATCH` and `DELETE` here, and the native restrict/grant/move/member routes
a platform relays) carries `Authz-Propagation: confirmed | pending` — whether the change is already enforced by the
authorization service (via the optional outbound `/sync/settle` above). It never changes the status or the body.
An absent header means unknown, never confirmed.

**Page restriction guards (1.7.0, wiki-v2 #493/#545).** In `AUTHZ_MODE=remote` the fork installs database triggers
that refuse to take a restriction away by anything but an explicit unrestrict or a purge: a native move-to-space of
a restricted page or of a page in a restricted section — checked on every page the move sets `space_id` on, even
one already in the target space (upstream deletes every moved page's restrictions) — and a
re-parent or restore-detach that takes an unrestricted page out from under its last restricted ancestor. A
restriction written takes the same lock and its `space_id` from the page, so a restrict and a move serialize. The
native routes answer a refusal — and a move cycle — with `409 { message, code }`, `code` one of
`ccc_page_no_cycle`, `ccc_page_restricted_space_move`, `ccc_page_restriction_strip`, and the refused statement's
transaction rolls back. A move rolls back whole; upstream's restore is not transactional, so on a refused detach the
un-trash has already committed and the page stays under its trashed, restricted parent (never declassified;
wiki-v2 issue 556).

**Conditional page operations (1.9.0, wiki-v2 #616).** `POST /api/service/pages/lifecycle-state` also reports the
page's own `position`. Beside the native page routes a platform relays as the acting user, the fork serves atomic
compare-and-write twins: `POST /api/pages/conditional-delete`, `conditional-move`, `conditional-move-to-space` and
`conditional-update-meta`, each taking the native body plus `expectedEtags` (1–8 opaque page versions, or exactly
`["*"]` for "the page exists"). The version is compared inside the write's transaction under the page row lock (`FOR
NO KEY UPDATE`, which never deadlocks with the restriction guards above): stale → `412 { code: precondition_failed }`
with nothing changed; already done → `200 { outcome: noop }` (never for a permanent delete); otherwise `200 {
outcome: applied }`. A busy engine answers a retryable `503 { code: engine_busy }`. The two moves settle like the
native moves (`Authz-Propagation`). A fork without these routes answers the framework's plain 404 — an integrator
must read that as "upgrade pending", never as page-not-found, and must never fall back to the unconditional route.

**Keyed page create (1.9.0, wiki-v2 #616).** `POST /api/pages/idempotent-create` (relayed as the acting user; `404` unless `AUTHZ_MODE=remote`) takes the native `POST /api/pages/create` body plus `idempotencyKey` (1–255), `idempotencyNamespace` (1–128, the integrator's key namespace) and `fingerprint` (64 lowercase hex, sha256 of the integrator's stable request body). The fork binds the key to the workspace, the authenticated user and the namespace, and records it in the page's own transaction for at least 24h. First use → `200` native body + `replayed: false`; same key + fingerprint → `200` with that page's current state, re-authorized, `replayed: true`, nothing re-run; different fingerprint → `409 { code: idempotency_key_reused }`; page since deleted → `404 { code: idempotency_resource_gone }`; busy → `503 { code: engine_busy }`. The native authorization runs on every call. A fork without the route answers the framework's plain 404 — read it as "upgrade pending", never as not-found. `POST /api/service/spaces` takes the same three fields, optionally (all or none; a partial key is a `400`): the key is recorded in the space insert's transaction, bound to the workspace, the service credential that authenticated the call and the creator (`creatorExternalId`, as its shadow user), so a key sent for another human — or through another credential — is a separate entry and can never answer this space. A repeat answers `{ id, slug, name, replayed: true }` and re-runs nothing (no space, member or outbox row; the creator's shadow-user upsert runs as on every call and is idempotent); a keyed create skips the friendly slug pre-check, so a slug held by another space is still the unique index's `409`; mismatch, gone and busy answer as for pages. Unkeyed, the space create is unchanged and its body carries no `replayed`.

**Versions, atomic compares and previews for ACLs, members and spaces (1.9.0, wiki-v2 #616).** The fork issues an
opaque `version` (64 hex, a digest of the resource's state — `service-bridge/resource-version.ts`) for a space
(`GET /api/service/content/spaces/{id}` and `GET /api/service/spaces/{id}`; over every public field plus the archived
state), a membership (each `GET …/members` item, the member `POST`) and a page's ACL (`GET
/api/service/pages/{id}/permissions`, which also answers `restricted`; over the restriction and every grant, read with
the items from one snapshot). `PATCH /api/service/spaces/{id}`, `POST …/archive`, `PATCH` and `DELETE
…/members/{memberId}` take an optional `expectedVersion` (a version, or `*` = it exists; archive and removal take it
as an optional JSON body) and compare it inside the write's transaction under the row lock they already take — stale
→ `412 { code: precondition_failed }` with nothing changed; the rename, archive and role change answer the new
`version`. The page-ACL routes a platform relays as the acting user (`POST /api/pages/restrict`,
`remove-restriction`, `add-permission`, `remove-permission`, `update-permission`) each run as ONE transaction under a
per-page lock `pg_advisory_xact_lock(616616, hashtext(pageId))` — taken first, before the workspace lock the guards
above take (no trigger ever takes it, so the order cannot invert) — take the same optional `expectedVersion`, and
answer `{ restricted | success, version, effect }`. Two previews write nothing: `POST /api/pages/restriction-preview`
(`{ pageId, action, …that route's body }`, same authorization; it runs the real write and rolls it back) and `POST
/api/service/spaces/{id}/members/preview` (scope `spaces:write`; shadow users are only looked up, never provisioned);
both answer `{ outcome: would_apply | noop | refused, code?, version, effect }` with the CURRENT version. Neither is a
narrowing route. A busy engine (a lock not got within 2 s, a deadlock, a statement over 15 s) answers a retryable
`503 { code: engine_busy }`; an ACL write is always bounded this way, a member / space write only when it compares.

Three properties bind the whole surface:

- **Mode-gated.** Every route is `404` unless the fork runs `AUTHZ_MODE=remote` (RemoteOnlyGuard, checked
  before the secret). In native mode there is no integrating platform and the surface does not exist.
- **Scoped + secret-gated.** Every request carries `x-authz-service-secret`; each `/api/service/*` route
  requires exactly one least-privilege scope (`session:mint`, `users:provision`, `users:resolve`,
  `workspace:read`, `workspace:settings:write`, `spaces:read`, `spaces:write`, `pages:read`, `pages:authz:read`,
  `content:read`, `content:search`, `attachments:read`, `changes:read`).
- **The platform is the authorization authority.** Identity-mutating endpoints are keyed only on an opaque
  `externalId` (no arbitrary-identity selection). The `content/*` read endpoints are a **privileged data
  plane, not a second gate**: the platform performs the PDP decision first and passes the authorized id set;
  the fork returns metadata for exactly those ids and does NOT re-authorize.

## Source of truth

These two specs are the single source of truth for the request/response shapes and the array caps. The fork's
consumer contract test and the reference platform's provider contract test both derive their canonical bodies
and caps from `authorization-service.openapi.json`; a drift between the code and this contract fails a test.
They supersede the retired `contract/pep-pdp.contract.json` fixture.

## Response shape on the east-west surface (incident #181)

Every `/api/service/*` operation and every `/api/collab/*` operation returns EXACTLY the body its
OpenAPI schema declares. Docmost's global `{ data, success, status }` response envelope (the upstream
`TransformHttpResponseInterceptor` registered in `main.ts`) is skipped on this surface via the upstream
per-handler `@SkipTransform()` decorator on every east-west handler. Two fork specs keep that true:
`service-bridge/service-scope-coverage.spec.ts` asserts the metadata on every route handler (build-time),
and `service-bridge/service-bridge.wire.spec.ts` boots the real Fastify pipeline with the interceptor and
asserts bare bodies against an undecorated negative control (pipeline-time). Until first-run setup creates
a workspace row, every operation answers the upstream `404 "Workspace not found"`; that exact pair is the
only response a consumer may read as "no workspace provisioned yet".
