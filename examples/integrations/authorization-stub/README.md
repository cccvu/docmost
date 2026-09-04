# Reference authorization stub

A zero-dependency Node reference implementation of the Docmost remote authorization + audit contract
([`../../../docs/integrations/authorization/authorization-service.openapi.json`](../../../docs/integrations/authorization/authorization-service.openapi.json)).

It exists so you can:

1. see the exact request/response wire shapes of the six endpoints, and
2. smoke-test a fork running with `AUTHZ_MODE=remote` without building a real policy engine.

**It is a skeleton, not a production authorization service.** Its policy is a small, deterministic,
**deny-by-default** allowlist. There is deliberately **no allow-all switch**: a copied stub denies
everything until you add explicit grants, so it can never become an accidental "allow everyone" service by
flipping one environment variable. Replace `decide()` in `server.mjs` with a call into your real engine
(SpiceDB, OPA, a database, whatever) to build a production service.

## Run it

Requires Node >= 18 (built-ins only; no `npm install`).

```bash
PLATFORM_AUTHZ_SERVICE_SECRET=your-shared-secret PORT=4000 node server.mjs
```

It refuses to start serving decisions if `PLATFORM_AUTHZ_SERVICE_SECRET` is unset (returns `503`), matching
the fail-closed contract.

## Point the fork at it

```
AUTHZ_MODE=remote
PLATFORM_AUTHZ_URL=http://localhost:4000
PLATFORM_AUTHZ_SERVICE_SECRET=your-shared-secret   # same value as the stub
```

A minimal compose wiring (fork in remote mode + this stub) for a local demo:

```yaml
services:
  authz-stub:
    image: node:22-alpine
    working_dir: /app
    volumes:
      - ./docmost/examples/integrations/authorization-stub:/app:ro
    environment:
      PLATFORM_AUTHZ_SERVICE_SECRET: your-shared-secret
      PORT: "4000"
    command: node server.mjs
  # ... your docmost service with AUTHZ_MODE=remote and PLATFORM_AUTHZ_URL=http://authz-stub:4000 ...
```

## The demo policy

`stub-policy.json` holds exact `{ externalId, permission, resourceType, resourceId }` grant tuples. Anything
not listed is denied. No wildcards on purpose, so every allowed decision is explicit and auditable. The
shipped grants match the examples in the contract (subject `externalId` `d-1`), so you can verify the wire
end to end:

```bash
S='your-shared-secret'
# allowed (d-1 may view space s-1) -> {"allowed":true}
curl -s -H "content-type: application/json" -H "x-authz-service-secret: $S" \
  -d '{"subject":{"provider":"docmost","externalId":"d-1"},"permission":"view","resourceType":"space","resourceId":"s-1"}' \
  http://localhost:4000/authz/check
# denied (no grant for space s-2) -> {"allowed":false}
curl -s -H "content-type: application/json" -H "x-authz-service-secret: $S" \
  -d '{"subject":{"provider":"docmost","externalId":"d-1"},"permission":"view","resourceType":"space","resourceId":"s-2"}' \
  http://localhost:4000/authz/check
```

Add a grant by appending a tuple to `stub-policy.json` and restarting.

## What it implements

All six contract endpoints, with the secret guard (`x-authz-service-secret`, constant-time), the array caps
(`check-bulk` <= 256, `filter-resources`/`filter-subjects` <= 1000, `audit/ingest` <= 500; over-cap -> `400`),
correct status codes (`200`/`202`/`400`/`401`/`404`/`405`/`503`), and the `{ provider: "docmost", externalId }`
subject shape. It does not attempt SpiceDB semantics, caching, or ZedToken freshness; those are the
responsibility of a real implementation.
