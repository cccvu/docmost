import { join } from 'path';
import { handlerCalls, scanRoutes } from '../route-guard/static-route-scan';
import { REMOTE_REFUSAL_FAMILIES, routesOf } from './remote-refusal.table';

/**
 * Directory reads FITNESS TEST (wiki-v2 #797) — NOT upstream Docmost code.
 *
 * In remote mode the workspace directory (members, invitations, groups and their members, space members) is not shown
 * to wiki users: the `directoryRead` family refuses the engine's native reads of it. Upstream gates each of them with
 * a CASL `Read` on a directory subject — workspace `Read` on `Member` / `Group` (any workspace member holds it), space
 * `Read` on `Member` (any space reader holds it) — so that handler text is the tell: the routes carrying it are EXACTLY
 * the refused keys, both ways. An upstream bump that adds such a read, or renames a refused handler (its key would
 * silently stop matching), fails RED here, and whoever does it decides: refuse it, or keep it with a reason.
 *
 * A static text heuristic, like the family specs beside it: a read that exposes the directory without that check is
 * invisible to it (`search/suggest` is one — its group results are gated in `PdpSearchService`, and its user results
 * stay for @mentions, an owner decision).
 */
const SRC_ROOT = join(__dirname, '..', '..'); // .../apps/server/src

export const DIRECTORY_READ_RE =
  /\bWorkspaceCaslAction\s*\.\s*Read\s*,\s*WorkspaceCaslSubject\s*\.\s*(?:Member|Group)\b|\bSpaceCaslAction\s*\.\s*Read\s*,\s*SpaceCaslSubject\s*\.\s*Member\b/;

describe('every native directory read is refused in remote (#797)', () => {
  const routes = scanRoutes(SRC_ROOT);
  const key = (r: { controller: string; handler: string }) => `${r.controller}.${r.handler}`;
  const refused = routesOf('directoryRead');

  it('scans a meaningful tree (guards against a silently-empty scan)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(80);
    expect(refused.size).toBe(6);
  });

  it('the directory-read routes are EXACTLY the refused directoryRead keys', () => {
    const reaching = routes.filter((r) => handlerCalls(r, DIRECTORY_READ_RE)).map(key).sort();
    expect(reaching).toEqual([...refused].sort());
  });

  it('the family covers the workspace members, invitations, group list/info/members and space members', () => {
    expect([...refused].sort()).toEqual([
      'GroupController.getGroup',
      'GroupController.getGroupMembers',
      'GroupController.getWorkspaceGroups',
      'SpaceController.getSpaceMembers',
      'WorkspaceController.getInvitations',
      'WorkspaceController.getWorkspaceMembers',
    ]);
  });

  it('keeps the public invitation-acceptance read and the @mention suggest reachable', () => {
    const all = new Set(REMOTE_REFUSAL_FAMILIES.flatMap((f) => [...f.routes.keys()]));
    for (const k of ['WorkspaceController.getInvitationById', 'SearchController.searchSuggestions']) {
      expect(routes.some((r) => key(r) === k)).toBe(true);
      expect([k, all.has(k)]).toEqual([k, false]);
    }
  });

  it('records no attempted space or group id against the workspace resource type', () => {
    const family = REMOTE_REFUSAL_FAMILIES.find((f) => f.id === 'directoryRead')!;
    expect(family.resourceType).toBe('workspace');
    for (const entry of family.routes.values()) expect(entry.resourceIdField).toBeUndefined();
  });
});

describe('the directory-read tell (meta-guard)', () => {
  it.each([
    ['ability.cannot(WorkspaceCaslAction.Read, WorkspaceCaslSubject.Member)'],
    ['ability.cannot(WorkspaceCaslAction.Read, WorkspaceCaslSubject.Group)'],
    ['ability.cannot(\n  SpaceCaslAction.Read,\n  SpaceCaslSubject.Member,\n)'],
  ])('matches %s', (text) => {
    expect(DIRECTORY_READ_RE.test(text)).toBe(true);
  });

  it.each([
    ['ability.cannot(WorkspaceCaslAction.Read, WorkspaceCaslSubject.Settings)'],
    ['ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Member)'],
    ['ability.cannot(SpaceCaslAction.Manage, SpaceCaslSubject.Member)'],
    ['ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Settings)'],
  ])('does not match %s', (text) => {
    expect(DIRECTORY_READ_RE.test(text)).toBe(false);
  });
});
