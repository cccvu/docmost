import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { SPACE_HARD_DELETE_CALL_RE, scanRoutes } from '../route-guard/static-route-scan';
import { SPACE_HARD_DELETE_ROUTES } from './space-hard-delete.interceptor';

/**
 * Space hard-delete FITNESS TEST (#502) — NOT upstream Docmost code.
 *
 * `SpaceHardDeleteInterceptor` refuses the native space delete in remote mode by `Controller.handler` key, so it is
 * only as good as that key set. This pins it statically (no imports of the real controllers, no boot):
 *  - the refused set is EXACTLY the set of routes whose handler reaches `.deleteSpace(` — both directions. An
 *    upstream bump that renames the handler (the key would silently stop matching and the route would be open) or
 *    adds a second route reaching the delete fails RED here;
 *  - the SINKS stay where they are: the only `DELETE FROM spaces`, the only callers of `.deleteSpace(`, and the only
 *    producer of the space attachment purge. A new indirect path to the sink (a job, a listener, another service)
 *    fails RED, and whoever adds it decides deliberately whether remote mode must refuse it too;
 *  - app.module.ts registers the interceptor innermost, after the per-principal rate limiter, so a flood of refused
 *    attempts is rate-limited and each attempt lands in the #467 access row.
 * A text inventory: a sink written through an unrecognized indirection is invisible to it (the classifier meta-guard
 * at the bottom pins the shapes it does recognize).
 */
const SRC_ROOT = join(__dirname, '..', '..'); // .../apps/server/src
const SKIP_DIRS = new Set(['ee', 'node_modules', 'dist']);

// `DELETE FROM spaces`, as Kysely (`deleteFrom('spaces')`, any quote, an alias) or as raw SQL.
export const SPACES_ROW_DELETE_RE =
  /deleteFrom\(\s*['"`]spaces(?:\s+as\s+\w+)?['"`]\s*\)|\bdelete\s+from\s+(?:"?public"?\.)?"?spaces"?(?![\w"])/i;
// A producer of the space attachment purge (the S3 half of the hard delete).
const SPACE_ATTACHMENT_PURGE_RE = /\.add\(\s*QueueJob\.DELETE_SPACE_ATTACHMENTS\b/;

// Code only: a sink named in a comment (this feature's own docs name them all) is not a sink. Block comments, then
// line comments not preceded by a `:` or quote (so `http://…` in a string survives).
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) sourceFiles(full, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('space hard delete is refused on every route that reaches it (#502)', () => {
  const routes = scanRoutes(SRC_ROOT);
  const key = (r: { controller: string; handler: string }) => `${r.controller}.${r.handler}`;
  const files = sourceFiles(SRC_ROOT).map((full) => ({
    file: full.slice(SRC_ROOT.length + 1).split('\\').join('/'),
    src: stripComments(readFileSync(full, 'utf8')),
  }));
  const filesMatching = (re: RegExp) =>
    files.filter((f) => re.test(f.src)).map((f) => f.file).sort();

  it('scans a meaningful tree (guards against a silently-empty scan)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(80);
    expect(files.length).toBeGreaterThanOrEqual(300);
  });

  it('every refused key names a real route', () => {
    const known = new Set(routes.map(key));
    expect([...SPACE_HARD_DELETE_ROUTES].filter((k) => !known.has(k))).toEqual([]);
  });

  it('the refused set is EXACTLY the routes whose handler reaches the space hard delete', () => {
    const reaching = routes.filter((r) => r.callsSpaceHardDelete).map(key).sort();
    expect(reaching).toEqual([...SPACE_HARD_DELETE_ROUTES].sort());
  });

  it('the only `DELETE FROM spaces` is SpaceRepo.deleteSpace', () => {
    expect(filesMatching(SPACES_ROW_DELETE_RE)).toEqual(['database/repos/space/space.repo.ts']);
  });

  it('`.deleteSpace(` is called only by the refused route and the service it calls', () => {
    expect(filesMatching(SPACE_HARD_DELETE_CALL_RE)).toEqual([
      'core/space/services/space.service.ts',
      'core/space/space.controller.ts',
    ]);
  });

  it('only SpaceService.deleteSpace queues the space attachment purge', () => {
    expect(filesMatching(SPACE_ATTACHMENT_PURGE_RE)).toEqual(['core/space/services/space.service.ts']);
  });

  it('app.module.ts registers the interceptor innermost, after the per-principal rate limiter', () => {
    const app = files.find((f) => f.file === 'app.module.ts')?.src ?? '';
    const limiter = app.indexOf('useClass: PrincipalRateLimitInterceptor');
    const refusal = app.indexOf('useClass: SpaceHardDeleteInterceptor');
    expect(limiter).toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(limiter);
  });
});

// The inventory is only as strong as the shapes these patterns recognize. Pin them so a later edit cannot quietly
// narrow detection.
describe('the space hard-delete patterns recognize every sink shape (meta-guard)', () => {
  it.each([
    [`.deleteFrom('spaces')`],
    [`.deleteFrom("spaces")`],
    ['.deleteFrom(`spaces`)'],
    [`.deleteFrom('spaces as s')`],
    [`sql\`DELETE FROM spaces WHERE id = \${id}\``],
    [`delete from "spaces" where id = $1`],
    [`delete from public.spaces where id = $1`],
  ])('flags %s as a spaces-row delete', (src) => {
    expect(SPACES_ROW_DELETE_RE.test(src)).toBe(true);
  });

  it.each([
    [`.deleteFrom('spaceMembers')`],
    [`.deleteFrom('space_members')`],
    [`after insert or update or delete on spaces`],
    [`delete from space_members where space_id = $1`],
  ])('does not flag %s', (src) => {
    expect(SPACES_ROW_DELETE_RE.test(src)).toBe(false);
  });

  it('the handler tell sees the service and repo delete, not the watcher unwatch', () => {
    expect(SPACE_HARD_DELETE_CALL_RE.test('this.spaceService.deleteSpace(id, ws)')).toBe(true);
    expect(SPACE_HARD_DELETE_CALL_RE.test('await this.spaceRepo.deleteSpace (id, ws)')).toBe(true);
    expect(SPACE_HARD_DELETE_CALL_RE.test('this.watcherRepo.deleteSpaceWatch(userId, spaceId)')).toBe(false);
  });
});
