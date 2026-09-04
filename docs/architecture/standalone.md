# Running this Docmost fork standalone

This is a fork of Docmost that adds a server-controlled authorization mode. It can run two ways:

- **`AUTHZ_MODE=native`** (this document): fully standalone. Docmost's own authorization (CASL plus the
  `space_members` / `page_access` / `page_permissions` tables) is the enforced control, and native
  email/password login is enabled. No external service is contacted. This is a legitimate, first-class mode,
  not an "allow all" or a degraded fallback.
- **`AUTHZ_MODE=remote`**: authorization decisions come from an external service over the published contract
  in [`../integrations/authorization/`](../integrations/authorization/), and native credential login is
  disabled server-side. See [`external-services.md`](./external-services.md).

`AUTHZ_MODE` is **required** and validated at boot. There is no default, the value is never inferred from
whether an authorization URL is set, and it cannot change at runtime. A missing or invalid value aborts
startup (this is the check that points you here).

## The one required setting

```
AUTHZ_MODE=native
```

In native mode you do NOT set `PLATFORM_AUTHZ_URL` or `PLATFORM_AUTHZ_SERVICE_SECRET`; native contacts no
external service, so those are neither read nor required.

## Quickest path: the standalone compose

A ready-to-run compose lives at [`../../deploy/standalone/`](../../deploy/standalone/). It builds this fork
from source and brings up only what Docmost itself needs (Postgres, Redis, this app), with no CCC platform
and no SpiceDB. From the fork root (`docmost/`):

```bash
cp deploy/standalone/.env.example deploy/standalone/.env   # then edit APP_SECRET / DB password
docker compose -f deploy/standalone/docker-compose.yml up --build
```

Open http://localhost:3000 and complete first-run setup (this creates the workspace and the first user).
Then sign in with that email and password. Create a space, create a page, edit it: all of this runs on
Docmost's own authorization.

`deploy/standalone/smoke.sh` runs that whole flow non-interactively, including a negative authorization
check (a second user is denied a page they were not granted), to prove native mode enforces real ACLs.

## Running from source without Docker

Native mode needs only Docmost's usual dependencies:

- Node (see `.nvmrc` / `package.json` engines) and pnpm
- PostgreSQL and Redis reachable via `DATABASE_URL` and `REDIS_URL`
- Object storage: `STORAGE_DRIVER=local` (a mounted disk) or S3-compatible storage

```bash
pnpm install
# minimal env
export AUTHZ_MODE=native
export APP_URL=http://localhost:3000
export APP_SECRET=$(openssl rand -hex 32)
export DATABASE_URL=postgres://docmost:docmost@localhost:5432/docmost
export REDIS_URL=redis://localhost:6379
export STORAGE_DRIVER=local
pnpm build
NODE_ENV=production pnpm --filter ./apps/server start   # migrations auto-run when NODE_ENV=production
```

## Tests

Docmost's own suite runs standalone:

```bash
cd apps/server && pnpm test
```

## What native mode does NOT give you

Native mode is Docmost's stock authorization. It does not provide the CCC platform's centralized,
relationship-based policy (SpiceDB), central audit, dynamic admin-editable roles, or the service bridge.
Those are `remote`-mode integrations, documented in [`external-services.md`](./external-services.md) and
[`integration-boundaries.md`](./integration-boundaries.md).
