import type { ServerResponse } from 'node:http';
import { isAbsolute, relative, sep } from 'node:path';
import fastifyStatic from '@fastify/static';

/**
 * CCC SPA asset delivery — NOT upstream Docmost code (issue #309).
 *
 * Upstream registers `@fastify/static` bare (`{ root, wildcard: false }`), so every SPA asset went out
 * uncompressed with @fastify/send's default `Cache-Control: public, max-age=0`: a full re-download of the
 * multi-MB hashed bundle on every navigation, and no way for the ALB/browser to skip it. This is the one
 * fork-owned place the client build's delivery policy lives; upstream's `static.module.ts` calls it at the
 * documented seam (#86) and keeps its own `window.CONFIG` injection and SPA fallback untouched.
 *
 * Vite emits every content-hashed file under `assets/` (safe to cache forever: a new build is a new URL) and
 * everything else (`index.html`, `locales/*.json`, `manifest.json`, icons) under a STABLE name, which must
 * revalidate on every use or a deploy would leave users on the old shell. The client build (the other half
 * of #309) also writes `.br` and `.gz` siblings next to each asset; this module serves them.
 */

/** A year, immutable: the browser never revalidates a content-hashed asset (RFC 8246). */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
/** Stable-name files: cacheable, but ALWAYS revalidated via the ETag @fastify/send emits (304 when fresh). */
export const REVALIDATE_CACHE_CONTROL = 'no-cache';

/** Vite's content-hashed output directory (relative to the client dist root). */
const HASHED_DIR = 'assets';
const PRECOMPRESSED_SUFFIX = /\.(br|gz)$/;

/**
 * The policy, pure so it is unit-testable without HTTP. `filePath` is the RESOLVED path @fastify/send chose
 * (so it may be the `.br`/`.gz` sibling); the suffix is normalised away before the directory test. Anything
 * not provably inside `<root>/assets/` — including a path outside the root — revalidates: the safe default.
 */
export function cacheControlFor(root: string, filePath: string): string {
  const rel = relative(root, filePath).replace(PRECOMPRESSED_SUFFIX, '');
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    return REVALIDATE_CACHE_CONTROL;
  }
  const [top, ...rest] = rel.split(sep);
  return top === HASHED_DIR && rest.length > 0
    ? IMMUTABLE_CACHE_CONTROL
    : REVALIDATE_CACHE_CONTROL;
}

/**
 * Append-merges one member into a `Vary` field value, treating it as the list it is (RFC 9110 §12.5.5).
 * Pure so it is unit-testable without HTTP. The existing value is returned VERBATIM when the token is
 * already present (case-insensitively, whitespace-tolerant) or when `*` is a member (`*` already means
 * "everything"; rewriting what another plugin set is never our call). Fastify may hand a multi-valued
 * header back as an array; it is flattened in order.
 */
export function mergeVary(
  existing: string | string[] | number | undefined | null,
  token: string,
): string {
  const current = Array.isArray(existing) ? existing.join(', ') : String(existing ?? '');
  const members = current.split(',').map((m) => m.trim().toLowerCase()).filter(Boolean);
  if (members.length === 0) return token;
  if (members.includes('*') || members.includes(token.toLowerCase())) return current;
  return `${current}, ${token}`;
}

/**
 * Registers `@fastify/static` for the client build at `root`. Option by option:
 *
 * - `wildcard: false` — upstream's choice, kept: one explicit route per file on disk, so anything that is
 *   NOT a file falls through to upstream's `app.get('*')` SPA fallback (with ITS no-store policy intact).
 * - `preCompressed: true` — negotiate `Accept-Encoding` and serve the `.br`/`.gz` sibling when it exists,
 *   with `Content-Encoding` set and the ORIGINAL file's content type; a file with no matching sibling is
 *   served as identity (never a 404). The negotiation happens per request, so `Vary` is mandatory below.
 * - `globIgnore` — the siblings and `index-template.html` (upstream's pristine copy of index.html, used to
 *   re-inject `window.CONFIG` on boot) are not routes of their own: `/x.js.br` must not be fetchable as a
 *   nameless octet stream, and the template must never be served in place of the injected index.
 * - `cacheControl: false` — MANDATORY. In @fastify/static 9.1.3 `setHeaders` runs on the RAW response
 *   BEFORE `reply.headers(sendHeaders)` is applied, and Fastify's final `writeHead` lets those reply
 *   headers win over raw ones; with cache control left on, send's own `public, max-age=0` would silently
 *   overwrite the policy set here. Turning it off leaves ETag/Last-Modified/Content-Length to send and the
 *   Cache-Control decision to `cacheControlFor`.
 * - `setHeaders` — receives the raw Node response and the RESOLVED file path (the sibling when one was
 *   picked) and sets ONLY the Cache-Control from `cacheControlFor`. It runs only for a real file, so a
 *   missing asset keeps the fallback's `no-cache, no-store, must-revalidate` rather than caching a 200
 *   HTML shell for a year. Nothing else sets Cache-Control on these routes, so a raw header is safe here.
 *
 * `Vary: Accept-Encoding` is NOT set in `setHeaders`: any plugin that sets Vary through the reply store
 * (`@fastify/cors` does, with `Vary: Origin`) would clobber a raw one, because Fastify writes reply-store
 * headers over raw ones. It is instead append-merged (`mergeVary`) in an `onSend` hook on the instance the
 * seam passes in (Docmost's root, so it RUNS for every response, a sub-microsecond property test) that ACTS
 * only for @fastify/static's per-file routes — recognised by the `config.file` it stamps on each route it
 * registers (`setUpHeadAndGet`) — never for API routes or the `*` fallback. The hook is added BEFORE the plugin is
 * registered on purpose: a route context snapshots the instance hooks when avvio runs its `after`, and
 * although in the Nest boot that happens at `ready()` (so the order is not load-bearing today — the
 * spec's mutation check confirms both orders pass), adding it first keeps the guarantee independent of
 * avvio scheduling should this ever be called on an instance that is already loading.
 */
export async function registerClientStatic(instance: any, root: string): Promise<void> {
  instance.addHook(
    'onSend',
    (request: any, reply: any, payload: unknown, done: (err: Error | null, payload?: unknown) => void) => {
      if (request?.routeOptions?.config?.file) {
        reply.header('Vary', mergeVary(reply.getHeader('Vary'), 'Accept-Encoding'));
      }
      done(null, payload);
    },
  );

  await instance.register(fastifyStatic, {
    root,
    wildcard: false,
    preCompressed: true,
    globIgnore: ['**/*.br', '**/*.gz', 'index-template.html'],
    cacheControl: false,
    setHeaders(res: ServerResponse, filePath: string) {
      res.setHeader('Cache-Control', cacheControlFor(root, filePath));
    },
  });
}
