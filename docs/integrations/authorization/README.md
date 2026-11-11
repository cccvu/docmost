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

`authorization-service.openapi.json` describes six required `POST` endpoints your service must expose:

- `/authz/check` -> `{ allowed }`
- `/authz/check-bulk` (<= 256 checks) -> `{ results }` (one boolean per check, in order)
- `/authz/filter-resources` (<= 1000 candidateIds) -> `{ ids }` (the authorized subset)
- `/authz/lookup-resources` -> `{ ids }` (the full authorized set)
- `/authz/filter-subjects` (<= 1000 candidates) -> `{ subjects }` (passing subjects, echoed verbatim)
- `/audit/ingest` (<= 500 events) -> `202 { accepted, persisted }` (fire-and-forget on the fork side)

And two OPTIONAL endpoints. A `404` from either is safe and is the reference stub's answer:

- `POST /sync/settle` `{ position, timeoutMs }` -> `{ status: "confirmed" | "pending", reason? }`. After a request that
  takes access away succeeds, the fork asks whether every access change up to its outbox position `position` is
  already reflected in your decisions, and reports the answer to its caller as the `Authz-Propagation` response
  header. Answer `confirmed` only when that is true. Positions (like change-feed cursors) order as a pair of
  64-bit integers `(xact_id, id)`, never as strings: `"9.9"` is before `"10.1"`. Without this route (404), every
  such response says `pending`: safe, never a failure. `AUTHZ_NARROWING_SETTLE_TIMEOUT_MS` (default 3000, max 5000, `0` = off) is
  how long the fork lets you wait. (1.1.0, #501)
- `GET /authz/edge-trust` (no body) -> `{ trustedProxies: string[], xffTrusted: boolean }`. Config, not a decision:
  which X-Forwarded-For hops your edge adds. The fork's collab server walks `[socket peer, ...X-Forwarded-For right
  to left]`, trusting the socket peer and then only these exact IP literals (at most 64; `xffTrusted: false` walks
  nothing), and shares its pool of unauthenticated collab sockets per resulting client address (128 of 512 each,
  then `429`). It fetches at boot without blocking it, retries from 1 s up to every 30 s, then refreshes every 5
  minutes. Without this route (`404`), or on any other failure or a malformed body, the per-address share stays off:
  the pool and its deadlines still apply, and no address is ever guessed. (1.3.0, wiki-v2 #810)

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
  malformed body, the fork grants nothing: a point decision or a list it could not get answered is a retryable
  `503` to the fork's own caller (wiki-v2 #696, #716), never an empty or partial list (one failed chunk fails
  the whole list). It NEVER falls back to native decisions. So returning `5xx` on your own errors is safe: it
  degrades to a retryable refusal, never to allow. A well-formed empty answer is a real "none".
- **Subjects arrive as** `{ "provider": "docmost", "externalId": "<docmost user id>" }` for every user
  decision. One exception (1.2.0, wiki-v2 #615): when a caller of the service-bridge `content/search` passes a
  `serviceSubjectId` (the CCC platform does for an on-behalf-of search), the fork also sends
  `/authz/filter-resources` a `{ "principalId": "<that id>", "subjectType": "service" }` subject for the
  service account's leg of each window. A service that denies that subject is safe (fail-closed), but every
  such search then comes back empty; one that never receives a `serviceSubjectId` never sees the shape.
- The reference implementation also rejects unknown request keys with `400` and enforces the array caps; the
  fork never sends unknown keys or over-cap arrays, so a faithful implementation is strict but never triggers
  those paths in normal operation.

**Publishing needs `share` (1.12.0, wiki-v2 #704). Behaviour-relevant for implementers.** In remote mode, every
change to a page's publish state asks `/authz/check-bulk`, in one batch, for the caller's `edit` and `share` on the
page (resource type `page`, the page's uuid; a slug is resolved first) and `edit` and `share` on the space the page's
row is in now (resource type `space`): creating its public share (`POST /api/shares/create`), updating it
(`POST /api/shares/update`: `includeSubPages`, `searchIndexing`; decided on the share's own page, never a `pageId` in
the body) and setting its expiry (`POST /api/shares/expiry`). The fork refuses with
`403 { message, code: share_not_permitted }` and writes nothing when you answer page `edit: true, share: false`, or
`edit: true` on the page or on the space with space `share: false`. The space pair is not redundant: for a page you
have not placed yet (new, or moved to another space), the route's own edit check falls back to the caller's role in
the page's current space. If the batch fails (a non-2xx, a timeout, a malformed or short body), it answers a
retryable `503` with `Retry-After`. Any other answer (no `edit` on the page or its space) leaves the route's own
checks to decide, unchanged: its `403` without `edit`, and its `400` for a restricted page. Unpublishing
(`POST /api/shares/delete`) still needs `edit` only. Native mode is unchanged.

`share` is a NEW permission name. An implementer that does not know it denies everyone publishing (a deny gives
`403`) or blocks publishing (a non-2xx gives `503`) until it models it. Grant it wherever your policy lets a principal
put pages on the public web. The reference model grants it to space writers and admins and to the workspace admin
cascade. It also grants it to a role with both `edit` and `share` bound at space scope, never in an archived space,
and always requires `edit`. A fork before 1.12.0 never asks for `share`. The reference stub's demo policy grants no
`share` tuple, because the replacement smoke publishes nothing.

### Reference stub

A zero-dependency Node reference implementation lives at
[`../../../examples/integrations/authorization-stub/`](../../../examples/integrations/authorization-stub/).
It implements all six required endpoints faithfully (secret check, caps, status codes, subject shape) with a
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
  `POST /api/service/content/spaces/list`, `GET /api/service/content/spaces/{id}`, and (1.8.0, #615)
  `POST /api/service/content/pages/ancestors`, `POST /api/service/content/labels/list`,
  `POST /api/service/content/activity/list`, `POST /api/service/content/spaces/comment-policy`.
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
- **Group control plane** (`groups`, 1.16.0, wiki-v2 #797; scopes `groups:read` / `groups:write`):
  `GET`/`POST /api/service/groups`, `GET`/`PATCH`/`DELETE /api/service/groups/{groupId}`,
  `GET .../groups/{groupId}/usage`, `GET`/`POST .../groups/{groupId}/members`, `DELETE .../groups/{groupId}/members/{externalId}`,
  `POST /api/service/groups/memberships/lookup` and `POST /api/service/groups/default/ensure`.
- **Collab** (`collab`): `POST /api/collab/revalidate` (re-check every live realtime connection after a
  narrowing access change and narrow the ones that lost access, #501; it replaced the per-page
  `force-disconnect` in 1.5.0) and `POST /api/collab/force-disconnect-user` (account disable, #455).

**Bounded engine workloads (1.11.0; wiki-v2 #696, #642).** `POST /api/service/content/search` answers `503` instead of
an empty result when the authorization service cannot answer, and `503 { code: engine_busy }` when the search is shed
(the per-process search bulkhead or the caller's two in-flight searches are full, a statement runs past its bound, or
the 6 s search deadline passes). Both are retryable; nothing was changed. `POST /api/service/pages/validate-content`
takes an optional `actorUserId` (the Docmost user the integrator validates for): its conversions take that user's
turn at the content converter, the same as the user's own writes. It is an admission key only, never used for
authorization. An engine before 1.11.0 drops the unknown field and validates on the shared actorless turn.

**1.14.0 (wiki-v2 #716).** `POST /api/service/pages/validate-content` also takes an optional `actorIdentityId` (the
platform identity of the acting human, always sent by the platform). It is the converter's admission key when
`actorUserId` is absent (`identity:<id>`, a per-human bucket, never the shared actorless one), and, like `actorUserId`,
never used for authorization. Its `429 conversion_budget_exhausted` is now in the document
(`RateLimitedOrConversionBudget`). In remote mode the native page routes answer `400 { code: use_v1 }` to a non-json
`format` echo (`/api/pages/info`, `/api/pages/update`, and `/api/pages/create` with content).

**1.15.0 (wiki-v2 #780).** Every `/api/service/*` route takes an optional `x-ccc-rate-principal` header, `user:<id>`
(the acting human) or `service:<id>` (a service account acting for nobody), the id a uuid. It is a rate-limit key only,
never identity or authority, and is read only after the secret and scope checks; a malformed value is
`400 { code: rate_principal_invalid }`, which never echoes it. Each scope has three token buckets that refill
continuously (no fixed window, so no 60 s cliff): one per principal, one global bucket for all calls that send the
header, and one unattributed bucket for calls that do not. A call with the header is charged to its principal's bucket
and the global one, all or nothing; a call without it, to the unattributed one only, so background callers are never
starved by user traffic. Sizes per minute (principal / global / unattributed, env `SERVICE_BRIDGE_<SCOPE>_RATE_LIMIT` /
`_GLOBAL_RATE_LIMIT` / `_UNATTRIBUTED_RATE_LIMIT` with `<SCOPE>` = `PAGES_READ`, `PAGES_AUTHZ`, `PAGES_IMPORT`, or none
for the default): `pages:read` and `pages:authz:read` 6000 / 60000 / 6000, `pages:import:read` 120 / 1200 / 120, every
other scope 1200 / 6000 / 600; missing or wrong-secret requests share one bucket of 600
(`SERVICE_BRIDGE_ANON_RATE_LIMIT`). One principal is isolated from another while all attributed calls together stay
under the global size; past it, every attributed caller of that scope is refused alike until the bucket refills. Every
refusal of an authenticated call is `429 { code: rate_limited }` with `Retry-After` (`RateLimitedError`); the anon
bucket's is `429 { code: service_auth_throttled }`, a credential fault an integrator must never read as its caller's own
throttle. The engine logs
`SERVICE_BRIDGE_RATE_LIMITED scope=<scope> bucket=principal|global|unattributed|anon` at most once a minute per bucket
kind, never the principal. An engine before 1.15.0 ignores the header and throttles every caller of a scope in one
fixed 60 s window, with an uncoded 429 and no `Retry-After`.

**1.16.0 (wiki-v2 #797).** A group control plane under `/api/service/groups` (above): data only, the platform
authorizes first. Members are added by `externalId` only (1..200 per call; a group is never a member of a group). The
workspace's default group changes only through `ensureDefaultGroup`, which is refused
(`409 { code: basic_group_has_grants }`) while any live space membership or page grant names it; every other write to
it is `409 { code: default_group_immutable }`. A group that still grants anything is not deleted
(`409 { code: group_in_use, spaceCount, pageCount }`), and removing a member is a narrowing route
(`Authz-Propagation`). `addSpaceMember` / `previewSpaceMember` take `externalId` XOR `groupId` and an optional
`mode` (`set`, the default, or `atLeast`, which never lowers), and answer `groupId` and `applied`; `userId` is null
for a group. A member write that RAISES a membership must be covered by what the acting human holds on the space:
reader needs `space#view`, writer `space#edit` and `space#share`, admin a live direct admin membership (own or through
a group) or `workspace#admin_cascade`, else `403 { code: grant_exceeds_actor }`; a settle fence not confirmed is
`503 { code: grant_unconfirmed }`. The default group is never granted on a space
(`400 { code: basic_group_not_grantable }`). In remote mode the relayed page-ACL routes (`/api/pages/add-permission`,
and an `update-permission` that raises) apply the same ceiling on the page: reader needs `page#view`, writer
`page#edit`, or `workspace#admin_cascade` (`403 { code: grant_exceeds_actor }`, retryable
`503 { code: grant_ceiling_unconfirmed }`), and refuse a group grantee on an add or a raise
(`400 { code: group_grant_not_allowed_on_restricted_page }`; existing group grants stay). The native directory reads
are refused (below), and `search/suggest` returns groups only to a caller who administers the workspace or a space.

**Native routes refused in remote mode (1.10.0; wiki-v2 #502, #598, #636).** In `AUTHZ_MODE=remote` the engine
answers `404` to every authenticated caller of the native routes below, before any permission check, and forwards one
audit row per refusal (its event in brackets) to `/audit/ingest`. A session minted before the switch to remote (an
owner's included) gets the same `404`. Since 1.16.0 (wiki-v2 #797) the directory reads are refused too; only the
public `invites/info` stays reachable. Native mode keeps every route.
- Space hard delete: `POST /api/spaces/delete` (`space.hard_delete_refused`). Remove a space with
  `POST /api/service/spaces/{id}/archive`.
- Space create: `POST /api/spaces/create` (`space.native_create_refused`). Use `POST /api/service/spaces`.
- Space members: `POST /api/spaces/members/add`, `.../remove` and `.../change-role`
  (`space.native_member_refused`). Use `/api/service/spaces/{id}/members`.
- Workspace admin: `POST /api/workspace/update`, `/api/workspace/members/{deactivate,activate,delete,change-role}`
  and `/api/workspace/invites/{create,resend,revoke,link}` (`workspace.native_admin_refused`). Workspace settings go
  through `PATCH /api/service/workspace/settings`.
- Group admin: `POST /api/groups/create`, `.../update`, `.../delete` and `/api/groups/members/{add,remove}`
  (`group.native_admin_refused`). Use `/api/service/groups` (1.16.0).
- Email change: `POST /api/users/update` when the body has an `email` key, even `null` or unchanged
  (`user.native_email_change_refused`). In remote mode a user's email is identity, which the platform owns. The
  name and preference forms still work.
- Directory reads (1.16.0, wiki-v2 #797): `POST /api/workspace/members`, `/api/workspace/invites`, `/api/groups`,
  `/api/groups/info`, `/api/groups/members` and `/api/spaces/members` (`directory.native_read_refused`). The
  platform console is the governed view.

In remote mode `users.role` confers no workspace authority either: a native-phase owner session gets the member
ability on every route gated on workspace permissions (1.10.0, #636).

**Permanent delete needs edit on every page it removes (1.10.0, #636).** In remote mode a permanent delete (`POST
/api/pages/delete {permanentlyDelete: true}`, `POST /api/pages/conditional-delete`) also requires `page#edit` for the
caller on every page it removes, trashed descendants included, decided under row locks after the access-change settle
fence: `403 { code: purge_needs_edit }` otherwise; `503 { code: purge_unconfirmed }` (retryable) when access changes
cannot be confirmed as enforced; `409 { code: purge_subtree_changed }` (retryable) when the subtree keeps changing.

**Remote page removal decides on every page (1.11.0, wiki-v2 #661, #618, #589, #670).** In remote mode a TRASH
(`POST /api/pages/delete`, `POST /api/pages/conditional-delete`, without `permanentlyDelete`) needs `page#edit` on
every live page it moves to the trash and moves exactly those: `403 { code: trash_needs_edit }`, retryable
`503 { code: trash_unconfirmed }` / `409 { code: trash_subtree_changed }`. A permanent delete also needs
`space#administer` on EVERY space its subtree touches (`403`), and is refused while any of them is archived
(`409 { code: space_archived }`); a move-to-space out of an archived space is the guard's
`409 { code: ccc_page_archived_space_move }`, and the trash retention never purges a subtree that still has a live or
unexpired page or touches an archived space. A platform relaying these for an on-behalf-of service principal may send
`x-ccc-acting-service: <the service account's principal id>`: the fork then also decides the same checks for that
service account (`{principalId, subjectType: 'service'}`), under the same locks, after the caller's. It only ever
narrows; a malformed value is `400 { code: acting_service_invalid }`; native mode ignores it.

**Access-narrowing propagation (1.6.0, #501).** A successful response from a route that can take access away
(`archive`, the member `POST` upsert, `PATCH` and `DELETE` here, and the native restrict/grant/move routes a
platform relays) carries `Authz-Propagation: confirmed | pending` — whether the change is already enforced by the
authorization service (via the optional outbound `/sync/settle` above). It never changes the status or the body.
An absent header means unknown, never confirmed. Since 1.10.0 the native space-member routes are refused in remote
mode (above): members change through `/api/service/spaces/{id}/members`.

**Page restriction guards (1.7.0, wiki-v2 #493/#545).** In `AUTHZ_MODE=remote` the fork installs database triggers
that refuse to take a restriction away by anything but an explicit unrestrict or a purge: a native move-to-space of
a restricted page or of a page in a restricted section — checked on every page the move sets `space_id` on, even
one already in the target space (upstream deletes every moved page's restrictions) — and a
re-parent or restore-detach that takes an unrestricted page out from under its last restricted ancestor. A
restriction written takes the same lock and its `space_id` from the page, so a restrict and a move serialize. The
native routes answer a refusal — and a move cycle — with `409 { message, code }`, `code` one of
`ccc_page_no_cycle`, `ccc_page_restricted_space_move`, `ccc_page_restriction_strip`, `ccc_page_archived_space_move` (a
move-to-space out of an archived space, wiki-v2 #589), and the refused statement's
transaction rolls back. A move rolls back whole; upstream's restore is not transactional, so on a refused detach the
un-trash has already committed and the page stays under its trashed, restricted parent (never declassified;
wiki-v2 issue 556).

**Knowledge reads (1.8.0, wiki-v2 #615).** `content/pages/list` gains page filters (labelName, lastUpdatedById,
created range, topLevel, descendantOf+maxDepth — walks only through supplied live pages —, linksTo/linkedFrom), a
`position` sort and a wire-only creator/last-editor projection; four new `content:read` operations serve ancestor
ids (facts to authorize), labels and activity over an authorized page set (pinned to the supplied ids, live,
workspace), and a space's viewer-comment setting (a fact, not a decision). `content/search` gains the same
narrowing filters (parentPageId, labelName, lastUpdatedById, updated range) applied BEFORE the authorization walk,
plus an optional `serviceSubjectId` so an on-behalf-of result is service ∩ user; it now answers
`{items, hasMore}`, where `hasMore` is true only when an authorized hit past the page was actually collected (a
scan-budget stop reports false, never a promise of an empty next page).

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

**Import helpers (1.9.0, wiki-v2 #616).** Two read-only routes a platform plans a page import with, under their own
scope `pages:import:read` (smaller rate buckets, `SERVICE_BRIDGE_PAGES_IMPORT_*`: see 1.15.0). `POST
/api/service/pages/validate-content` `{ items: [{ format: markdown | html, content }] }` (1–50 items) parses each item
exactly as a page create would (including the network-inert HTML parse), writes nothing, and answers `{ results: [{ idx,
ok: true } | { idx, ok: false, code }] }` in item order — `too_large` (over 512 KiB, or once the call's budget of 1 MiB
parsed is spent, for that item and every later one), `parse_budget_exceeded` (once the call's 4 s of parsing is spent,
for that item and every later one: NOT checked, a retryable engine-load answer, never a content verdict), `empty_content`
(whitespace only) or `invalid_content`; it never answers content or a parse error, and a call that finds both parse slots busy for 2 s is a
retryable `503 { code: engine_busy }`. `POST /api/service/pages/title-candidates` `{ spaceId, parentPageId?: uuid | null,
titles: [1–50 strings, 1–255] }` answers `{ matches: [{ titleIdx, pageId, suffix: null | n }] }`: the live direct
children of that parent (null or omitted = the space root) whose title is exactly `titles[titleIdx]` or `<title> (n)`
with n ≥ 2 — case-sensitive, ids and indices only, never a title. A parent with more than 5000 live children answers
`503 { code: list_too_broad }`. The integrator keeps only the matches its caller may view.

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
  `pages:import:read`,
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
