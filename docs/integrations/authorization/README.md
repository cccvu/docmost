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

`service-bridge.openapi.json` describes the three east-west endpoints the fork hosts for an integrating
platform: `POST /api/service/users` (provision a shadow user), `POST /api/service/session` (mint a session),
and `POST /api/collab/force-disconnect`. These are keyed on an opaque `externalId`, gated by the same
`x-authz-service-secret` header (plus per-route scopes on `/api/service/*`), and never allow a caller to
select an arbitrary Docmost identity. You only implement a *caller* for these; the fork is the server.

## Source of truth

These two specs are the single source of truth for the request/response shapes and the array caps. The fork's
consumer contract test and the reference platform's provider contract test both derive their canonical bodies
and caps from `authorization-service.openapi.json`; a drift between the code and this contract fails a test.
They supersede the retired `contract/pep-pdp.contract.json` fixture.
