/**
 * CCC authorization integration — NOT upstream Docmost code (wiki-v2 #713).
 *
 * The engine's native admin-tier routes that `AUTHZ_MODE=remote` answers only for a FRESHLY authenticated session,
 * as DATA. `RemoteStepUpInterceptor` looks each request up here by `<ControllerClass>.<handler>` and, for a hit,
 * refuses with `403 step_up_required` unless the request's own `user_sessions` row records a platform freshness that
 * has not lapsed (`session-freshness.ts`). A 403 and never a 401: the SPA silently re-mints its session on a 401,
 * which would replay the action with a session that is just as stale.
 *
 * Each route is irreversible or widens exposure, and a 30-day wiki session can otherwise reach it without the human
 * being present:
 *  - `purge`: a permanent delete removes the page and its whole subtree for good (trash stays ungated: it is
 *    reversible);
 *  - `pageAcl`: the five page-restriction writes; an unrestrict or a grant widens who can read a confidential page;
 *  - `spaceSettings`: the space update, which can turn public sharing back on.
 *
 * Reads are never stepped up, here or on the platform: the space export is one, and the page/subtree export and
 * `/v1/pages/export` reach the same content ungated, so gating it alone was cosmetic. The fitness spec records the
 * routes deliberately left ungated, with their reasons (exports, and the share writes).
 *
 * Every key is pinned to a real `@Post` route whose path equals `route`, and each kind's key set is pinned both ways
 * against the code that reaches its sink (`remote-step-up.fitness.spec.ts`). Native (standalone) mode gates nothing.
 */

export type StepUpKind = 'purge' | 'pageAcl' | 'spaceSettings';

export interface StepUpRoute {
  readonly kind: StepUpKind;
  /** `POST <path>`, equal to the scanned route's path (the fitness spec pins it). */
  readonly route: string;
  /**
   * Gate only when this returns `true` for the raw body (the interceptor runs before the `ValidationPipe`). Absent
   * means always gate; a throw gates (fail closed).
   */
  readonly when?: (body: unknown) => boolean;
}

/**
 * A permanent delete, read fail closed from the raw body: ONLY a plain object whose `permanentlyDelete` is absent,
 * `null` or `false` is a trash. Any other value — `true`, but also `"true"`, `1`, an object — is gated; the
 * `@IsBoolean` DTO (or `RemotePurgeInterceptor`) refuses it later anyway, so gating it costs nothing and never depends
 * on how a later layer coerces it. A body that is not a plain object carries no flag and cannot purge.
 */
export const purgesPermanently = (body: unknown): boolean => {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  const flag = (body as Record<string, unknown>).permanentlyDelete;
  return !(flag === undefined || flag === null || flag === false);
};

export const REMOTE_STEP_UP_ROUTES: ReadonlyMap<string, StepUpRoute> = new Map<string, StepUpRoute>([
  ['PageController.delete', { kind: 'purge', route: 'POST /api/pages/delete', when: purgesPermanently }],
  [
    'ConditionalPageOpsController.conditionalDelete',
    { kind: 'purge', route: 'POST /api/pages/conditional-delete', when: purgesPermanently },
  ],
  ['PageRestrictionController.restrict', { kind: 'pageAcl', route: 'POST /api/pages/restrict' }],
  ['PageRestrictionController.removeRestriction', { kind: 'pageAcl', route: 'POST /api/pages/remove-restriction' }],
  ['PageRestrictionController.addPermission', { kind: 'pageAcl', route: 'POST /api/pages/add-permission' }],
  ['PageRestrictionController.removePermission', { kind: 'pageAcl', route: 'POST /api/pages/remove-permission' }],
  ['PageRestrictionController.updatePermission', { kind: 'pageAcl', route: 'POST /api/pages/update-permission' }],
  ['SpaceController.updateSpace', { kind: 'spaceSettings', route: 'POST /api/spaces/update' }],
]);

/** The `Controller.handler` keys of one kind. */
export function stepUpRoutesOf(kind: StepUpKind): ReadonlySet<string> {
  return new Set([...REMOTE_STEP_UP_ROUTES].filter(([, r]) => r.kind === kind).map(([key]) => key));
}
