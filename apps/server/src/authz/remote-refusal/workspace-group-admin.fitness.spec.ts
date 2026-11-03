import { join } from 'path';
import { handlerCalls, scanRoutes } from '../route-guard/static-route-scan';
import { routesOf } from './remote-refusal.table';

/**
 * Workspace + group admin FITNESS TEST (#636) — NOT upstream Docmost code.
 *
 * Upstream gates its workspace and group admin routes with workspace CASL `Manage`, and in remote mode that ability
 * comes from `users.role`, not the PDP. So the tell is the handler text `WorkspaceCaslAction.Manage`: every route
 * carrying it is either refused (the `workspaceAdmin`, `groupAdmin` and `spaceNativeCreate` families) or on the
 * reasoned KEEP list below — both ways. An upstream bump that adds a Manage-gated route, or renames a refused handler
 * (its key would silently stop matching), fails RED here, and whoever does it decides deliberately: refuse it, or keep
 * it with a reason. A KEEP entry must still carry the tell (the equality below), so the list cannot go stale.
 *
 * A static text heuristic: a route that checks Manage through a service, or upstream code that spells the check
 * another way, is invisible to it. The remote WorkspaceAbilityFactory rebind (`authz/mode/workspace-ability.ts`, which
 * gives every role member rules in remote) is the backstop that does not depend on the text.
 */
const SRC_ROOT = join(__dirname, '..', '..'); // .../apps/server/src

export const WORKSPACE_MANAGE_RE = /\bWorkspaceCaslAction\s*\.\s*Manage\b/;

/** Manage-gated routes remote mode deliberately does NOT refuse here, each with its reason. */
const KEEP: ReadonlyMap<string, string> = new Map([
  [
    'FileTaskController.getFileTasks',
    'a read: lists import task rows in the spaces the caller is a member of; it writes nothing',
  ],
  [
    'AttachmentController.uploadAvatarOrLogo',
    'mixed handler: the avatar and space-icon branches are member actions; the workspace-icon branch is closed by the remote WorkspaceAbilityFactory rebind',
  ],
  [
    'AttachmentController.removeIcon',
    'mixed handler, as uploadAvatarOrLogo; the workspace-icon branch is closed by the remote WorkspaceAbilityFactory rebind',
  ],
]);

describe('every workspace-CASL Manage route is refused in remote or kept with a reason (#636)', () => {
  const routes = scanRoutes(SRC_ROOT);
  const key = (r: { controller: string; handler: string }) => `${r.controller}.${r.handler}`;
  const refused = new Set([...routesOf('workspaceAdmin'), ...routesOf('groupAdmin'), ...routesOf('spaceNativeCreate')]);

  it('scans a meaningful tree (guards against a silently-empty scan)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(80);
  });

  it('the Manage-gated routes are EXACTLY the refused workspace/group/space-create keys plus KEEP', () => {
    const reaching = routes.filter((r) => handlerCalls(r, WORKSPACE_MANAGE_RE)).map(key).sort();
    expect(reaching).toEqual([...refused, ...KEEP.keys()].sort());
  });

  it('every workspaceAdmin and groupAdmin key carries the tell (no key is refused on a guess)', () => {
    const byKey = new Map(routes.map((r) => [key(r), r]));
    for (const k of [...routesOf('workspaceAdmin'), ...routesOf('groupAdmin')]) {
      expect([k, handlerCalls(byKey.get(k)!, WORKSPACE_MANAGE_RE)]).toEqual([k, true]);
    }
  });

  it('KEEP and the refused set are disjoint, and every KEEP entry has a reason', () => {
    expect([...KEEP.keys()].filter((k) => refused.has(k))).toEqual([]);
    for (const reason of KEEP.values()) expect(reason.length).toBeGreaterThan(20);
  });
});

describe('the workspace Manage tell (meta-guard)', () => {
  it.each([
    ['ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Member)'],
    ['ability.cannot(\n  WorkspaceCaslAction.Manage,\n  WorkspaceCaslSubject.Settings,\n)'],
    ['ability.can(WorkspaceCaslAction . Manage, x)'],
  ])('matches %s', (text) => {
    expect(WORKSPACE_MANAGE_RE.test(text)).toBe(true);
  });

  it.each([
    ['ability.cannot(WorkspaceCaslAction.Read, WorkspaceCaslSubject.Member)'],
    ['ability.cannot(SpaceCaslAction.Manage, SpaceCaslSubject.Member)'],
    ['WorkspaceCaslAction.ManageAll'],
  ])('does not match %s', (text) => {
    expect(WORKSPACE_MANAGE_RE.test(text)).toBe(false);
  });
});
