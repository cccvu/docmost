# Standalone Docmost (native mode)

Run this Docmost fork on its own, with its own authorization (`AUTHZ_MODE=native`) and no CCC platform or
SpiceDB. This directory lives inside the fork so the independence proof needs nothing from the super-repo.

See [`../../docs/architecture/standalone.md`](../../docs/architecture/standalone.md) for the full guide.

## Quickstart

From the fork root (`docmost/`):

```bash
cp deploy/standalone/.env.example deploy/standalone/.env
# edit deploy/standalone/.env: set APP_SECRET (openssl rand -hex 32) and POSTGRES_PASSWORD
docker compose -f deploy/standalone/docker-compose.yml up --build
```

Then open http://localhost:3000, complete first-run setup, and sign in.

Services: `postgres`, `redis`, `docmost` (built from this fork), and `mailpit` (a local SMTP catcher at
http://localhost:8025 so invites and password-reset work; point `SMTP_*` at a real server for production).
Attachments use local disk (`STORAGE_DRIVER=local`); switch to S3 if you prefer.

## Smoke test

`smoke.sh` boots the stack and verifies, end to end and non-interactively:

1. the fork builds and boots in `AUTHZ_MODE=native`,
2. native credential auth works (setup + login; a wrong password is `401`, not the remote-mode `404`),
3. **native authorization is enforced, not allow-all**: a second user is denied (`403`/`404`; Docmost
   returns not-found to a non-member) a page in a space they are not a member of, while the owner reads it
   (`200`),
4. no CCC services (`platform` / `spicedb`) are in the stack.

```bash
docmost/deploy/standalone/smoke.sh          # builds, tests, tears down
KEEP_UP=1 docmost/deploy/standalone/smoke.sh # leave the stack up for inspection
```

Requires `docker` (compose v2), `curl`, and `jq`.
