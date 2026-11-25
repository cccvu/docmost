/**
 * wiki-v2 #736 fitness function: a CCC wait or deadline never reads the wall clock.
 *
 * Every wait or deadline that holds a request, a worker, a socket or a revocation reads `performance.now()`: an NTP or
 * chrony step of the wall clock must neither stretch nor cut it (a step back held a relay poll, a settle wait or a
 * revocation pass for the step; a step forward shed work at once). `Date.now()` stays for real timestamps (stored or
 * signed), measurements that hold nothing, and rate-limit, retry and log windows. This scans every non-spec source
 * under the CCC trees with the TypeScript AST (comments and strings do not count) and fails on a `Date.now` reference
 * (a call or a function value) in a file, or a count, that the reasoned allowlist below does not record. A new one is
 * either moved to `performance.now()` or added here with its reason.
 *
 * Run in CI via the `docmost-authz` job's jest roots (`src/authz`).
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, relative, resolve, sep } from 'path';
import * as ts from 'typescript';

const SRC_ROOT = resolve(__dirname, '..', '..');
/** The CCC-owned trees (paths relative to apps/server/src). */
const ROOTS = ['authz', 'editor-compat', 'service-bridge'];

/** Every file that may read the wall clock, how many times, and why none of them is a wait or a deadline. */
const ALLOWED: Record<string, number> = {
  'authz/http-authz.client.ts': 1, // the per-path failure-log throttle (a log window)
  'authz/step-up/session-freshness.ts': 1, // a real timestamp: JWT epoch seconds (`auth_time`, `mpa`)
  'authz/collab-ingress/frame-admission.ts': 1, // the awareness token bucket (a rate window)
  'authz/collab-ingress/socket-bounds.ts': 2, // the frame-rate clock it hands admitCollabFrame; the drain's logged ms
  'authz/collab-ingress/auth-rate.ts': 2, // the collab auth token buckets (a rate window)
  'authz/collab-ingress/update-guard.ts': 1, // per-user collab CPU buckets, the order-strike hold, claim expiry (ADR 0036 rate/penalty windows)
  'authz/collab-ingress/socket-limit-log.ts': 1, // the rate-limited warning (a log window)
  'authz/request-controls/api-access-audit.interceptor.ts': 2, // the audited duration (a measurement; it holds nothing)
  'authz/page-write/heal-image.ts': 4, // the lineage timestamp a heal image stores; the content-heal retry window
  'authz/page-write/compaction.ts': 2, // the lineage timestamp a compaction stores (`writeLineage`)
  'authz/page-write/compaction-registry.ts': 1, // compaction spacing and the page-full lapse (rate windows)
};

const walk = (dir: string, out: string[]): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', '__fixtures__'].includes(entry.name)) walk(full, out);
    } else if (/\.ts$/.test(entry.name) && !/\.(spec|testkit|d)\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
};

type Use = { file: string; line: number };

/** Every `Date.now` reference in `text`: `Date.now()`, `Date.now` passed as a value, `globalThis.Date.now`. */
const usesIn = (file: string, text: string): Use[] => {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: Use[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'now' &&
      ((ts.isIdentifier(node.expression) && node.expression.text === 'Date') ||
        (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'Date'))
    ) {
      found.push({ file: relative(SRC_ROOT, file).split(sep).join('/'), line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
};

describe('a CCC wait or deadline never reads the wall clock (wiki-v2 #736)', () => {
  const files = ROOTS.flatMap((r) => walk(join(SRC_ROOT, r), []));
  const uses = files.flatMap((f) => usesIn(f, readFileSync(f, 'utf8')));

  it('scans the CCC trees (not vacuous: the roots exist and hold the sources)', () => {
    for (const r of ROOTS) expect(existsSync(join(SRC_ROOT, r))).toBe(true);
    expect(files.length).toBeGreaterThan(200); // 254 at wiki-v2 #736
  });

  it('every Date.now use is in an allowlisted file', () => {
    expect(uses.filter((u) => !(u.file in ALLOWED))).toEqual([]);
  });

  it('each allowlisted file uses it exactly as often as recorded (a new use is reviewed; the allowlist is not stale)', () => {
    const counts: Record<string, number> = {};
    for (const u of uses) counts[u.file] = (counts[u.file] ?? 0) + 1;
    expect(counts).toEqual(ALLOWED);
  });

  it('the converted waits stay monotonic (each reads performance.now)', () => {
    for (const f of [
      'authz/page-write/op-semaphore.ts',
      'authz/search/pdp-search.service.ts',
      'authz/live-access/live-access.revalidator.ts',
      'authz/live-access/narrowing-settle.interceptor.ts',
      'authz/collab-ingress/collab-quiesce.ts',
      'authz/collab-ingress/preauth-slots.ts',
      'editor-compat/content-parse/content-parse.service.ts',
      'editor-compat/content-parse/conversion-budget.ts',
      'editor-compat/export/export-conversion.ts',
      'editor-compat/export/export-stream.ts',
      'service-bridge/authz-change-feed.service.ts',
      'service-bridge/service-page-import.service.ts',
    ]) {
      expect([f, readFileSync(join(SRC_ROOT, f), 'utf8').includes('performance.now()')]).toEqual([f, true]);
    }
  });

  it('is not vacuous: it flags a call, a function value and globalThis.Date, but not comments or strings', () => {
    const lines = (src: string) => usesIn(join(SRC_ROOT, 'x.ts'), src).map((u) => u.line);
    expect(lines(`const deadline = Date.now() + 1000;`)).toEqual([1]);
    expect(lines(`const clock = { now: Date.now };\nconst t = globalThis.Date.now();`)).toEqual([1, 2]);
    expect(lines(`// Date.now() in a comment\nconst s = 'Date.now()';\nconst m = performance.now();`)).toEqual([]);
  });
});
