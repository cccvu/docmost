import { join, resolve, sep } from 'path';
import {
  classifySpecifier,
  scanImportEdges,
  scanSource,
  type ImportEdge,
} from './import-boundary-scan';

/**
 * Fork-independence import-boundary FITNESS TEST — NOT upstream Docmost code (GitHub #172, epic #157, ADR 0014).
 *
 * The import-graph complement to `scripts/check-upstream-boundary.sh` (which is file-diff level and blind to
 * imports). It parses every `apps/server/src/**` source (see import-boundary-scan.ts) and enforces the three
 * fork-internal invariants that keep the fork independently buildable and upgrade-able:
 *
 *   (2) NO CCC-owned code (authz/, service-bridge/, editor-compat/) imports `apps/server/src/ee/` — the
 *       closed EE gitlink (CLAUDE.md hard-rule #1). Upstream Docmost imports `ee/` pervasively (mfa, api-key,
 *       licence, typesense, imports…) — that is Docmost's own EE integration, out of scope here; and
 *       *initializing* the empty gitlink is already caught by `check-upstream-boundary.sh` (the gitlink is a
 *       tracked diff). This rule keeps OUR code decoupled from the closed EE.
 *   (4) NO relative import escapes the fork root (`docmost/`) — a `../…/services/…` climb RESOLVES in a super
 *       checkout (docmost/ is a subdir there) so it passes the fork build yet breaks a standalone clone. This
 *       is the real "fork depends on the super repo"; the AGPL out-of-process direction (services ↛ docmost)
 *       is enforced by the platform's agpl-import-boundary.spec.ts.
 *   (3) NO upstream-owned file imports `authz/**`/`service-bridge/**` except the enumerated DI/composition
 *       seams. CCC integration must enter upstream ONLY at those seams; a new upstream importer is exactly the
 *       hidden coupling the text check misses when the edit hides inside an already-documented seam file.
 *
 * The rule-3 seam allowlist is kept IN the fork (not parsed from the super's UPSTREAM_MODIFICATIONS.md) to
 * preserve fork independence — a third party auditing only the fork gets the whole check. A new legitimate
 * seam updates BOTH this Set and its UPSTREAM_MODIFICATIONS.md heading (deliberate defense-in-depth), and the
 * ledger-equivalence below reds on a STALE entry too, forcing hygiene.
 *
 * Limitations (documented, accepted — each fails CLOSED):
 *   - Classification is by resolved path prefix / specifier text, not full module resolution — indirection
 *     (a re-export barrel that launders an ee/escape import) is not followed, but the direct edge is caught
 *     and over-reporting is the safe direction.
 *   - Rule 3 keys on FILE-level upstream/CCC ownership (path prefix), not per-symbol; an upstream file may not
 *     import authz/service-bridge at all unless it is a listed seam, which is stricter than "only the seam
 *     symbol", i.e. fail-closed.
 */

// apps/server/src (this spec lives at apps/server/src/authz/route-guard/).
const SRC_ROOT = resolve(__dirname, '..', '..');

// CCC-owned server subtrees (first-class CCC code — free to import each other; rule 3 does NOT apply to them).
const CCC_PREFIXES = ['authz', 'service-bridge', 'editor-compat'];

// The ONLY upstream-owned files permitted to import authz/** or service-bridge/** — the documented
// DI/composition seams (each cross-referenced to its UPSTREAM_MODIFICATIONS.md heading). Paths are relative
// to SRC_ROOT, POSIX-separated. Keep in lockstep with UPSTREAM_MODIFICATIONS.md.
const SEAM_ALLOWLIST = new Set<string>([
  'database/database.module.ts', // seam #1 — the DI rebind (AuthzModule + mode/repo-providers)
  'app.module.ts', // seam #4 — CollabDisconnectModule + PlatformAuditModule + PlatformAuthorizationGuard
  'core/search/search.module.ts', // seam #5 — PDP-gated search provider
  'integrations/static/static.module.ts', // seam #86 — client capability injection (NATIVE_AUTH_ENABLED, reads authz mode)
  'core/auth/auth.controller.ts', // seam #87 — NativeAuthModeGuard/NativeCredentialRoute on credential routes
  'core/workspace/controllers/workspace.controller.ts', // seam #87/#88 — native-auth gate on the session-mint route
]);

const posix = (p: string) => p.split(sep).join('/');
const isUpstream = (file: string) => !CCC_PREFIXES.some((p) => file === p || file.startsWith(p + '/'));

describe('fork import boundary — the fork stays independently buildable (issue #172, ADR 0014)', () => {
  const edges: ImportEdge[] = scanImportEdges(SRC_ROOT).map((e) => ({ ...e, file: posix(e.file) }));

  it('actually scanned the tree (guards against a silently-empty / broken walk)', () => {
    // A regression that broke the walker/AST (wrong root, parse failure) would find nothing and pass vacuously.
    const files = new Set(edges.map((e) => e.file));
    expect(files.size).toBeGreaterThanOrEqual(100);
    expect(edges.length).toBeGreaterThanOrEqual(500);
    // Sanity: the known seams are present in the scan (so rule 3 is exercising real edges).
    expect(edges.some((e) => e.file === 'database/database.module.ts' && e.kind === 'ccc')).toBe(true);
  });

  it('(rule 2) no CCC-owned code (authz/service-bridge/editor-compat) couples to the closed EE gitlink', () => {
    // Upstream Docmost imports ee/ pervasively (its own EE integration) — out of scope. This guards OUR code.
    const violations = edges
      .filter((e) => e.kind === 'ee' && !isUpstream(e.file))
      .map((e) => `${e.file}  ->  ${e.specifier}`);
    expect(violations).toEqual([]);
  });

  it('(rule 4) no import escapes the fork root (docmost/) — no dependency on the super repo', () => {
    const violations = edges.filter((e) => e.kind === 'escape').map((e) => `${e.file}  ->  ${e.specifier}`);
    expect(violations).toEqual([]);
  });

  it('(rule 3) no upstream-owned file imports authz/** or service-bridge/** outside the documented seams', () => {
    const offenders = edges.filter((e) => e.kind === 'ccc' && isUpstream(e.file) && !SEAM_ALLOWLIST.has(e.file));
    // A new upstream file reaching into CCC code. Either move the integration to a documented seam, or (if it
    // genuinely IS a new seam) add it to SEAM_ALLOWLIST here AND to UPSTREAM_MODIFICATIONS.md.
    expect(offenders.map((e) => `${e.file}  ->  ${e.specifier}`)).toEqual([]);
  });

  it('(rule 3 hygiene) every SEAM_ALLOWLIST entry is still an upstream file that imports CCC code (no stale grant)', () => {
    const importers = new Set(edges.filter((e) => e.kind === 'ccc' && isUpstream(e.file)).map((e) => e.file));
    const stale = [...SEAM_ALLOWLIST].filter((f) => !importers.has(f));
    // A seam allow-listed here that no longer imports authz/service-bridge (file deleted, or the import moved).
    // Remove it (dead grant) so the allowlist reflects the true seam set.
    expect(stale).toEqual([]);
  });
});

// The tree scan is only as strong as the shapes the classifier recognizes. This pins that strength: every
// boundary-crossing idiom must read as its kind, every benign idiom as 'other'. A future edit that weakens
// detection (so a real leak slips through) reds HERE — the mutation guard for the guard itself.
describe('the import classifier recognizes every boundary-crossing shape (meta-guard)', () => {
  const at = (rel: string) => join(SRC_ROOT, rel); // a synthetic importing file, resolved against the real root
  const k = (fileRel: string, spec: string) => classifySpecifier(at(fileRel), spec, SRC_ROOT);

  it("flags 'ee' — @docmost/ee alias and a relative import into ee/", () => {
    expect(k('probe.ts', '@docmost/ee/billing/billing.service')).toBe('ee');
    expect(k('core/page/page.service.ts', '../../ee/billing')).toBe('ee');
  });

  it("flags 'escape' — a relative climb out of docmost/ (the real fork->platform coupling)", () => {
    // apps/server/src/probe.ts: src -> server -> apps -> docmost -> super (4 ups escapes).
    expect(k('probe.ts', '../../../../services/platform/foo')).toBe('escape');
    // deeper file needs more ups; a same-depth-insufficient climb is NOT an escape (stays in docmost/).
    expect(k('probe.ts', '../../../packages/x')).toBe('other');
  });

  it("flags 'ccc' — an import that resolves into authz/, service-bridge/, or editor-compat/", () => {
    expect(k('core/auth/auth.controller.ts', '../../authz/mode/native-auth-mode.guard')).toBe('ccc');
    expect(k('app.module.ts', './authz/audit/audit.module')).toBe('ccc');
    expect(k('some/upstream/file.ts', '../../service-bridge/service-bridge.module')).toBe('ccc');
    // editor-compat/ is a CCC module (the typography-schema work); the classifier guards it in lockstep with
    // CCC_PREFIXES so rule 3 fires if an upstream file reaches into it. Path-based, so it holds as it grows.
    expect(k('some/upstream/file.ts', '../../editor-compat/schema/x')).toBe('ccc');
    expect(k('probe.ts', 'src/authz/mode/authz-mode')).toBe('ccc');
  });

  it("classifies benign imports as 'other' (node_modules, non-ee @docmost aliases, internal upstream)", () => {
    expect(k('probe.ts', '@nestjs/common')).toBe('other');
    expect(k('probe.ts', '@docmost/db/repos/user/user.repo')).toBe('other');
    expect(k('probe.ts', '@docmost/transactional/emails/x')).toBe('other');
    expect(k('core/page/page.controller.ts', './page.service')).toBe('other');
    expect(k('core/page/page.controller.ts', '../casl/abilities/space-ability.factory')).toBe('other');
  });

  it('collects every import form (static, type-only, export-from, dynamic import(), require)', () => {
    // All six name @docmost/ee/* so the assertion isolates FORM COLLECTION from path resolution.
    const src = [
      "import { A } from '@docmost/ee/a';",
      "import type { B } from '@docmost/ee/b';",
      "export { C } from '@docmost/ee/c';",
      "const d = await import('@docmost/ee/d');",
      "const e = require('@docmost/ee/e');",
      "import f = require('@docmost/ee/f');",
    ].join('\n');
    const edges = scanSource(join(SRC_ROOT, 'core', 'probe.ts'), src, SRC_ROOT);
    // all six forms are seen and classified as ee imports.
    expect(edges.filter((e) => e.kind === 'ee').length).toBe(6);
  });
});
