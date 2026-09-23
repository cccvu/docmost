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
