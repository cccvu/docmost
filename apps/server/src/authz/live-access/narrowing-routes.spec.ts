import { join } from 'path';
import { scanRoutes } from '../route-guard/static-route-scan';
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

  it('covers every narrowing family the ADR names (restrict/grants, move, members, archive)', () => {
    for (const key of [
      'PageRestrictionController.restrict',
      'PageRestrictionController.removePermission',
      'PageController.movePageToSpace',
      'SpaceController.removeSpaceMember',
      'GroupController.removeGroupMember',
      'ServiceSpaceController.archive',
      'ServiceSpaceController.removeMember',
    ]) {
      expect(NARROWING_ROUTES.has(key)).toBe(true);
    }
  });
});
