import { join } from 'path';
import { scanRoutes } from '../route-guard/static-route-scan';
import { REMOTE_REFUSED_ROUTES } from '../remote-refusal/remote-refusal.table';
import { NARROWING_ROUTES } from './narrowing-routes';

/**
 * #501 Part B: every narrowing-table entry names a real route. The table is keyed `<Controller>.<handler>`, so an
 * upstream rename (or a moved handler) would silently drop the settle for that route; this cross-check against
 * the same static route scan the Layer-C inventory uses turns that into a red build.
 */
describe('narrowing route table', () => {
  const routes = new Set(
    scanRoutes(join(__dirname, '..', '..')).map(
      (r) => `${r.controller}.${r.handler}`,
    ),
  );

  it('the scan is not vacuous', () => {
    expect(routes.size).toBeGreaterThanOrEqual(80);
  });

  it.each([...NARROWING_ROUTES])('%s is a real controller route', (key) => {
    expect(routes.has(key)).toBe(true);
  });

  // #616: a conditional (If-Match) move must settle exactly like the native move it replaces — the interceptor keys on
  // `<Controller>.<handler>`, so each native move and its conditional twin are pinned TOGETHER, and the conditional
  // delete / metadata update stay out like the native trash and update.
  it('pins each conditional move with its native twin, and keeps the conditional delete/update-meta out', () => {
    for (const [native, conditional] of [
      ['PageController.movePage', 'ConditionalPageOpsController.conditionalMove'],
      ['PageController.movePageToSpace', 'ConditionalPageOpsController.conditionalMoveToSpace'],
    ]) {
      expect([NARROWING_ROUTES.has(native), NARROWING_ROUTES.has(conditional)]).toEqual([true, true]);
    }
    for (const out of [
      'PageController.delete',
      'PageController.update',
      'ConditionalPageOpsController.conditionalDelete',
      'ConditionalPageOpsController.conditionalUpdateMeta',
    ]) {
      expect(routes.has(out)).toBe(true);
      expect(NARROWING_ROUTES.has(out)).toBe(false);
    }
  });

  // #636: remote mode refuses the native membership routes before the handler, so their settle entries are dead in
  // remote and kept for native. Exactly these three may overlap: a NEW overlap means a narrowing route that remote
  // now 404s (decide whether its platform twin settles), and a missing one means a refusal was lifted or renamed.
  it('overlaps the remote refusal table in exactly the three native membership routes', () => {
    expect([...NARROWING_ROUTES].filter((k) => REMOTE_REFUSED_ROUTES.has(k)).sort()).toEqual([
      'GroupController.removeGroupMember',
      'SpaceController.removeSpaceMember',
      'SpaceController.updateSpaceMemberRole',
    ]);
  });

  it('covers every narrowing family the ADR names (restrict/grants, move, members, archive)', () => {
    for (const key of [
      'PageRestrictionController.restrict',
      'PageRestrictionController.removePermission',
      'PageController.movePageToSpace',
      'SpaceController.removeSpaceMember',
      'GroupController.removeGroupMember',
      'ServiceSpaceController.archive',
      'ServiceSpaceController.removeMember',
      'ServiceGroupController.removeMember', // #797
    ]) {
      expect(NARROWING_ROUTES.has(key)).toBe(true);
    }
  });

  // #797: of the governed group routes, only the member removal narrows (an add, a rename, the ensure only widen or
  // change nothing; a delete is refused while the group grants anything). A new group route must be decided here.
  it('settles exactly the governed group member removal among the group control plane routes', () => {
    const groupRoutes = [...routes].filter((k) => k.startsWith('ServiceGroupController.')).sort();
    expect(groupRoutes.length).toBeGreaterThanOrEqual(11);
    expect(groupRoutes.filter((k) => NARROWING_ROUTES.has(k))).toEqual(['ServiceGroupController.removeMember']);
  });
});
