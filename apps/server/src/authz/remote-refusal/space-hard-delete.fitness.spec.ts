import { readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';
import { literalText, ownerOf, sourceFiles } from '../route-guard/ast-sink-scan';
import { handlerCalls, scanRoutes } from '../route-guard/static-route-scan';
import { routesOf } from './remote-refusal.table';

/**
 * Space hard-delete FITNESS TEST (#502) — NOT upstream Docmost code.
 *
 * `RemoteNativeRefusalInterceptor` refuses the native space delete in remote mode by `Controller.handler` key (the
 * `spaceHardDelete` family of `remote-refusal.table.ts`), so it is only as good as that key set. This pins it statically (no imports of the real controllers, no boot):
 *  - the refused set is EXACTLY the set of routes whose handler reaches `.deleteSpace(` — both directions. An
 *    upstream bump that renames the handler (the key would silently stop matching and the route would be open) or
 *    adds a second route reaching the delete fails RED here;
 *  - the SINKS stay where they are, per METHOD and per occurrence (TS AST, so comments and string contents never
 *    count): the only `DELETE FROM spaces` is in `SpaceRepo.deleteSpace`, `.deleteSpace(` is called only from
 *    `SpaceService.deleteSpace` and `SpaceController.deleteSpace`, and only `SpaceService.deleteSpace` queues the
 *    space attachment purge. A new method that reaches a sink — a `bulkDelete` looping the repo, a job, a listener —
 *    fails RED, and whoever adds it decides deliberately whether remote mode must refuse it too.
 * The interceptor's registration (once, after the per-principal rate limiter) is pinned in remote-refusal.fitness.spec.ts.
 * A static inventory: a sink reached through an unrecognized indirection (a method passed by reference, a dynamic
 * property name) is invisible to it. The meta-guard at the bottom pins the shapes it does recognize.
 */
const SRC_ROOT = join(__dirname, '..', '..'); // .../apps/server/src

// Text tell that a handler body reaches the space hard delete (#502): `spaceService.deleteSpace(` today, or a direct
// `spaceRepo.deleteSpace(`. The `(` right after the name keeps `deleteSpaceWatch(` out.
export const SPACE_HARD_DELETE_CALL_RE = /\.deleteSpace\s*\(/;

// Raw SQL `DELETE FROM spaces` inside a string or template literal.
export const RAW_SPACES_ROW_DELETE_RE = /\bdelete\s+from\s+(?:"?public"?\.)?"?spaces"?(?![\w"])/i;
// Kysely `deleteFrom('spaces')` / `deleteFrom('spaces as s')`: the table argument.
const SPACES_TABLE_RE = /^spaces(?:\s+as\s+\w+)?$/;
const RAW_WORKSPACES_ROW_DELETE_RE = /\bdelete\s+from\s+(?:"?public"?\.)?"?workspaces"?(?![\w"])/i;
const WORKSPACES_TABLE_RE = /^workspaces(?:\s+as\s+\w+)?$/;

// `workspaceRowDelete`: `spaces.workspace_id` is ON DELETE CASCADE, so deleting a workspace row deletes every space in it.
type SinkKind = 'spacesRowDelete' | 'workspaceRowDelete' | 'deleteSpaceCall' | 'spaceAttachmentPurge';
export interface SinkSite {
  kind: SinkKind;
  /** `Class.method` (or the function name) that encloses the occurrence; `<module>` at top level (see `ownerOf`). */
  owner: string;
}

/** Every space hard-delete sink in one source file, attributed to its enclosing method. Pure; exported for the meta-guard. */
export function scanSpaceDeleteSinks(fileName: string, source: string): SinkSite[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const sites: SinkSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      const first = node.arguments[0];
      if (name === 'deleteSpace') sites.push({ kind: 'deleteSpaceCall', owner: ownerOf(node) });
      if (name === 'deleteFrom' && first && SPACES_TABLE_RE.test(literalText(first) ?? '')) {
        sites.push({ kind: 'spacesRowDelete', owner: ownerOf(node) });
      }
      if (name === 'deleteFrom' && first && WORKSPACES_TABLE_RE.test(literalText(first) ?? '')) {
        sites.push({ kind: 'workspaceRowDelete', owner: ownerOf(node) });
      }
      if (name === 'add' && first && first.getText(sf).replace(/\s/g, '') === 'QueueJob.DELETE_SPACE_ATTACHMENTS') {
        sites.push({ kind: 'spaceAttachmentPurge', owner: ownerOf(node) });
      }
    }
    const text = literalText(node);
    if (text !== undefined && RAW_SPACES_ROW_DELETE_RE.test(text)) {
      sites.push({ kind: 'spacesRowDelete', owner: ownerOf(node) });
    }
    if (text !== undefined && RAW_WORKSPACES_ROW_DELETE_RE.test(text)) {
      sites.push({ kind: 'workspaceRowDelete', owner: ownerOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

describe('space hard delete is refused on every route that reaches it (#502)', () => {
  const routes = scanRoutes(SRC_ROOT);
  const key = (r: { controller: string; handler: string }) => `${r.controller}.${r.handler}`;
  const files = sourceFiles(SRC_ROOT).map((full) => {
    const file = full.slice(SRC_ROOT.length + 1).split('\\').join('/');
    const src = readFileSync(full, 'utf8');
    return { file, src, sinks: scanSpaceDeleteSinks(file, src) };
  });
  // Every occurrence of a sink kind as `file:Owner.method`, one entry per occurrence (so a second call counts).
  const sitesOf = (kind: SinkKind) =>
    files
      .flatMap((f) => f.sinks.filter((s) => s.kind === kind).map((s) => `${f.file}:${s.owner}`))
      .sort();

  it('scans a meaningful tree (guards against a silently-empty scan)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(80);
    expect(files.length).toBeGreaterThanOrEqual(300);
    // …and the AST scan actually finds sinks (else every inventory below would pass vacuously on `[]`).
    expect(files.some((f) => f.sinks.length > 0)).toBe(true);
  });

  it('every refused key names a real route', () => {
    const known = new Set(routes.map(key));
    expect([...routesOf('spaceHardDelete')].filter((k) => !known.has(k))).toEqual([]);
  });

  it('the refused set is EXACTLY the routes whose handler reaches the space hard delete', () => {
    const reaching = routes.filter((r) => handlerCalls(r, SPACE_HARD_DELETE_CALL_RE)).map(key).sort();
    expect(reaching).toEqual([...routesOf('spaceHardDelete')].sort());
  });

  it('the only `DELETE FROM spaces` is the one in SpaceRepo.deleteSpace', () => {
    expect(sitesOf('spacesRowDelete')).toEqual(['database/repos/space/space.repo.ts:SpaceRepo.deleteSpace']);
  });

  it('`.deleteSpace(` is called exactly once each, by the refused route and by the service it calls', () => {
    expect(sitesOf('deleteSpaceCall')).toEqual([
      'core/space/services/space.service.ts:SpaceService.deleteSpace',
      'core/space/space.controller.ts:SpaceController.deleteSpace',
    ]);
  });

  it('nothing deletes a workspace row (it would cascade to every space in it)', () => {
    expect(sitesOf('workspaceRowDelete')).toEqual([]);
  });

  it('only SpaceService.deleteSpace queues the space attachment purge', () => {
    expect(sitesOf('spaceAttachmentPurge')).toEqual([
      'core/space/services/space.service.ts:SpaceService.deleteSpace',
    ]);
  });
});

// The inventory is only as strong as the shapes the scanner recognizes. Pin them so a later edit cannot quietly
// narrow detection — including the Security finding this replaced: a per-FILE check stayed green when a second method
// in an already-listed file reached the sink.
describe('the space hard-delete sink scanner recognizes every sink shape (meta-guard)', () => {
  const kinds = (src: string) => scanSpaceDeleteSinks('probe.ts', src).map((s) => `${s.kind}@${s.owner}`);

  it.each([
    [`class R { d() { return this.db.deleteFrom('spaces').execute(); } }`],
    [`class R { d() { return this.db.deleteFrom("spaces").execute(); } }`],
    ['class R { d() { return this.db.deleteFrom(`spaces`).execute(); } }'],
    [`class R { d() { return this.db.deleteFrom('spaces as s').execute(); } }`],
    ['class R { d(id) { return sql`DELETE FROM spaces WHERE id = ${id}`.execute(this.db); } }'],
    [`class R { d() { return this.pg.query('delete from "spaces" where id = $1'); } }`],
    [`class R { d() { return this.pg.query('delete from public.spaces where id = $1'); } }`],
  ])('flags a spaces-row delete: %s', (src) => {
    expect(kinds(src)).toEqual(['spacesRowDelete@R.d']);
  });

  it.each([
    [`class R { d() { return this.db.deleteFrom('spaceMembers').execute(); } }`],
    [`class R { d() { return this.db.deleteFrom('space_members').execute(); } }`],
    [`const t = 'after insert or update or delete on spaces';`],
    [`const q = 'delete from space_members where space_id = $1';`],
    [`// this.db.deleteFrom('spaces')\n/* sql\`delete from spaces\` */ const x = 1;`],
  ])('does not flag %s', (src) => {
    expect(kinds(src)).toEqual([]);
  });

  it('attributes each occurrence to its enclosing method, so a NEW method in a listed file is caught', () => {
    const src = `class SpaceService {
      async deleteSpace(id) { await this.spaceRepo.deleteSpace(id); }
      async bulkDelete(ids) { for (const id of ids) await this.spaceRepo.deleteSpace(id); }
    }`;
    expect(kinds(src)).toEqual([
      'deleteSpaceCall@SpaceService.deleteSpace',
      'deleteSpaceCall@SpaceService.bulkDelete',
    ]);
  });

  it('attributes a sink bound to a local to the METHOD, not the local (a moved sink must change the inventory)', () => {
    expect(kinds(`class R { d() { const s = this.db.deleteFrom('spaces'); return s.execute(); } }`)).toEqual([
      'spacesRowDelete@R.d',
    ]);
    expect(kinds('class R { d(id) { const q = sql`delete from spaces where id = ${id}`; return q; } }')).toEqual([
      'spacesRowDelete@R.d',
    ]);
  });

  it('counts a second call inside the same method', () => {
    const src = `class C { deleteSpace() { this.s.deleteSpace(1); this.s.deleteSpace(2); } }`;
    expect(kinds(src)).toEqual(['deleteSpaceCall@C.deleteSpace', 'deleteSpaceCall@C.deleteSpace']);
  });

  it('sees the attachment purge and a workspace delete (which cascades to every space)', () => {
    expect(kinds(`class S { d() { this.q.add(QueueJob.DELETE_SPACE_ATTACHMENTS, s); } }`)).toEqual([
      'spaceAttachmentPurge@S.d',
    ]);
    expect(kinds(`class W { d() { return this.db.deleteFrom('workspaces').execute(); } }`)).toEqual([
      'workspaceRowDelete@W.d',
    ]);
    expect(kinds(`const f = () => pg.query('DELETE FROM workspaces WHERE id = $1');`)).toEqual([
      'workspaceRowDelete@f',
    ]);
  });

  it('ignores the watcher unwatch and a sink-looking string outside SQL position', () => {
    expect(kinds(`class W { u() { this.watcherRepo.deleteSpaceWatch(u, s); } }`)).toEqual([]);
    expect(kinds(`const accept = 'image/*'; class R { d() { return 1; } }`)).toEqual([]);
  });

  it('the route tell sees the service and repo delete, not the watcher unwatch', () => {
    expect(SPACE_HARD_DELETE_CALL_RE.test('this.spaceService.deleteSpace(id, ws)')).toBe(true);
    expect(SPACE_HARD_DELETE_CALL_RE.test('await this.spaceRepo.deleteSpace (id, ws)')).toBe(true);
    expect(SPACE_HARD_DELETE_CALL_RE.test('this.watcherRepo.deleteSpaceWatch(userId, spaceId)')).toBe(false);
  });
});
