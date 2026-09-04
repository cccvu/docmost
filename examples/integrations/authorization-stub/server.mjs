#!/usr/bin/env node
// Reference implementation of the Docmost remote authorization + audit contract
// (docmost/docs/integrations/authorization/authorization-service.openapi.json).
//
// This is a SKELETON to show the wire shapes and to smoke-test a fork running with AUTHZ_MODE=remote
// WITHOUT a real policy engine. It is NOT a production authorization service: its policy is a small,
// deterministic, DENY-BY-DEFAULT allowlist read from stub-policy.json. There is deliberately NO
// allow-all switch: a copied stub denies everything until you add explicit grants, so it can never be
// turned into an accidental "allow everyone" service by flipping one environment variable.
//
// Zero dependencies (Node >= 18 built-ins only). Run:
//   PLATFORM_AUTHZ_SERVICE_SECRET=your-shared-secret node server.mjs
// Then point the fork at it: PLATFORM_AUTHZ_URL=http://localhost:4000 (this stub's base URL).

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PORT = Number(process.env.PORT || 4000);
const SECRET = process.env.PLATFORM_AUTHZ_SERVICE_SECRET || '';
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB, ample for the capped batches below

// Per-path array field + cap, mirroring the contract. Over-cap => 400 (as the real platform does).
const CAPS = {
  '/authz/check-bulk': ['checks', 256],
  '/authz/filter-resources': ['candidateIds', 1000],
  '/authz/filter-subjects': ['candidates', 1000],
  '/audit/ingest': ['events', 500],
};

// The allowed top-level request keys per path. The real platform rejects unknown keys (class-validator
// forbidNonWhitelisted); this stub does the same so it faithfully matches the published contract.
const ALLOWED_KEYS = {
  '/authz/check': ['subject', 'permission', 'resourceType', 'resourceId'],
  '/authz/check-bulk': ['subject', 'checks'],
  '/authz/filter-resources': ['subject', 'permission', 'resourceType', 'candidateIds'],
  '/authz/lookup-resources': ['subject', 'permission', 'resourceType'],
  '/authz/filter-subjects': ['permission', 'resourceType', 'resourceId', 'candidates'],
  '/audit/ingest': ['events'],
};

// Validate a parsed body BEFORE any handler runs: reject a non-object, an unknown top-level key, or a
// non-array where the contract requires an array (so malformed authenticated input is a clean 400, never a
// crash). Returns an error string, or null when OK.
function validateBody(path, body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'body must be a JSON object';
  const allowed = ALLOWED_KEYS[path] || [];
  for (const k of Object.keys(body)) if (!allowed.includes(k)) return `unknown field: ${k}`;
  const capSpec = CAPS[path];
  if (capSpec) {
    const [field] = capSpec;
    if (body[field] !== undefined && !Array.isArray(body[field])) return `${field} must be an array`;
  }
  return null;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const policy = JSON.parse(readFileSync(join(__dirname, 'stub-policy.json'), 'utf8'));
const GRANTS = Array.isArray(policy.grants) ? policy.grants : [];

// ---- the demo policy: exact-match, deny-by-default -------------------------------------------------
// A grant is an exact { externalId, permission, resourceType, resourceId } tuple. No wildcards on
// purpose: every allowed decision is explicit and auditable in stub-policy.json. Replace decide() with
// a call into your real engine to build a production service.
function decide(subject, permission, resourceType, resourceId) {
  const externalId = subject && subject.externalId;
  if (!externalId) return false; // this fork only ever sends { provider:'docmost', externalId }
  return GRANTS.some(
    (g) =>
      g.externalId === externalId &&
      g.permission === permission &&
      g.resourceType === resourceType &&
      g.resourceId === resourceId,
  );
}
function grantedResourceIds(subject, permission, resourceType) {
  const externalId = subject && subject.externalId;
  if (!externalId) return [];
  return GRANTS.filter(
    (g) => g.externalId === externalId && g.permission === permission && g.resourceType === resourceType,
  ).map((g) => g.resourceId);
}

// ---- transport helpers ----------------------------------------------------------------------------
function safeSecretMatch(provided) {
  const a = Buffer.from(String(provided ?? ''));
  const b = Buffer.from(SECRET);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function send(res, status, body) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

function overCap(path, body) {
  const spec = CAPS[path];
  if (!spec) return false;
  const [field, max] = spec;
  const arr = body?.[field];
  return Array.isArray(arr) && arr.length > max;
}

const HANDLERS = {
  '/authz/check': (b) => ({ allowed: decide(b.subject, b.permission, b.resourceType, b.resourceId) === true }),
  '/authz/check-bulk': (b) => ({
    results: (b.checks || []).map((c) => decide(b.subject, c.permission, c.resourceType, c.resourceId) === true),
  }),
  '/authz/filter-resources': (b) => ({
    ids: (b.candidateIds || []).filter((id) => decide(b.subject, b.permission, b.resourceType, id)),
  }),
  '/authz/lookup-resources': (b) => ({ ids: grantedResourceIds(b.subject, b.permission, b.resourceType) }),
  '/authz/filter-subjects': (b) => ({
    subjects: (b.candidates || []).filter((s) => decide(s, b.permission, b.resourceType, b.resourceId)),
  }),
};

const server = createServer((req, res) => {
  // Fail-closed: refuse to serve at all if no secret is configured.
  if (!SECRET) return send(res, 503, { error: 'service secret not configured' });
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

  const path = (req.url || '').split('?')[0];
  const isAudit = path === '/audit/ingest';
  if (!HANDLERS[path] && !isAudit) return send(res, 404, { error: 'not found' });

  if (!safeSecretMatch(req.headers['x-authz-service-secret'])) {
    return send(res, 401, { error: 'invalid or missing service secret' });
  }

  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY_BYTES) {
      aborted = true;
      send(res, 413, { error: 'payload too large' });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (aborted) return;
    let body;
    try {
      const raw = Buffer.concat(chunks).toString('utf8');
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return send(res, 400, { error: 'invalid json' });
    }
    const invalid = validateBody(path, body);
    if (invalid) return send(res, 400, { error: invalid });
    if (overCap(path, body)) return send(res, 400, { error: 'array over cap' });

    // Any unexpected handler error is a 400, never a process-killing uncaughtException.
    try {
      if (isAudit) {
        const events = Array.isArray(body.events) ? body.events : [];
        // A real sink would persist here; the stub just counts and logs.
        console.error(`[stub] audit/ingest accepted ${events.length} event(s)`);
        return send(res, 202, { accepted: events.length, persisted: events.length });
      }
      return send(res, 200, HANDLERS[path](body));
    } catch {
      return send(res, 400, { error: 'malformed request' });
    }
  });
});

server.listen(PORT, () => {
  console.error(
    `[stub] reference authorization service on :${PORT} — DENY-BY-DEFAULT, ${GRANTS.length} explicit grant(s) loaded from stub-policy.json. NOT a production PDP.`,
  );
});
