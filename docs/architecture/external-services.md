# External services (remote mode)

In `AUTHZ_MODE=remote`, this fork depends on two external capabilities, both reached over the published
contract in [`../integrations/authorization/`](../integrations/authorization/). You can implement them
yourself; the CCC platform is one implementation, and a zero-dependency reference stub ships at
[`../../examples/integrations/authorization-stub/`](../../examples/integrations/authorization-stub/).

If you only want to run Docmost by itself, use `AUTHZ_MODE=native` and ignore this document
(see [`standalone.md`](./standalone.md)).

## 1. Authorization service (required in remote mode)

The fork delegates every fine-grained authorization decision to this service and fails closed if it is
unreachable. Contract: `authorization-service.openapi.json` (six `POST` endpoints: `check`, `check-bulk`,
`filter-resources`, `lookup-resources`, `filter-subjects`, and `audit/ingest`).

Configuration:

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `AUTHZ_MODE` | yes | none | must be `remote` to use these services |
| `PLATFORM_AUTHZ_URL` | yes (remote) | none | base URL of your authorization service (no path prefix) |
| `PLATFORM_AUTHZ_SERVICE_SECRET` | yes (remote) | none | shared secret (>= 16 chars) sent as `x-authz-service-secret` |
| `PLATFORM_AUTHZ_TIMEOUT_MS` | no | 1500 | per-request timeout, clamped to [250, 60000] |

Behavior you must design around:

- **Fail-closed.** A non-2xx, a timeout, a dropped connection, or a malformed body is treated as deny/empty.
  Returning `5xx` on your own errors is safe: it degrades to deny, never to allow.
- **Constant-time secret check.** Compare `x-authz-service-secret` in constant time; `401` on mismatch, `503`
  if you have no secret configured.
- **Respond within the timeout.** The fork aborts the request at `PLATFORM_AUTHZ_TIMEOUT_MS`.
- **Subject shape.** Subjects always arrive as `{ "provider": "docmost", "externalId": <docmost user id> }`.

## 2. Audit sink (fire-and-forget)

The fork forwards domain-audit events to `POST /audit/ingest` (part of the same contract and the same
`PLATFORM_AUTHZ_URL` base and secret). This is fire-and-forget: the fork does not read the response body and
swallows errors, so audit never blocks a user request. A faithful sink returns `202 { accepted, persisted }`.

## 3. The service bridge (the platform calls the fork)

In remote mode the fork also EXPOSES east-west endpoints an integrating platform uses to provision a shadow
user and mint a Docmost session, and to force-disconnect a collab session. Contract:
`service-bridge.openapi.json`. These are gated by the same `x-authz-service-secret` header (plus per-route
scopes on `/api/service/*`) and are keyed only on an opaque `externalId`, so a caller can never select an
arbitrary Docmost identity. You implement a *caller* for these; the fork is the server.

## Reference implementation and quickstart

See [`../integrations/authorization/README.md`](../integrations/authorization/README.md) for the full
contract walkthrough and [`../../examples/integrations/authorization-stub/`](../../examples/integrations/authorization-stub/)
for a runnable, deny-by-default reference authorization service you can point the fork at in remote mode.
