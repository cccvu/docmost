import 'reflect-metadata';
import { GUARDS_METADATA, MODULE_METADATA } from '@nestjs/common/constants';
import { SKIP_TRANSFORM_KEY } from '../common/decorators/skip-transform.decorator';
import { ServiceBridgeModule } from './service-bridge.module';
import { ServiceAuthGuard, SERVICE_SCOPE_KEY } from './service-auth.guard';
import { ServiceScope } from './service-scope';
import { RemoteOnlyGuard } from '../authz/mode/remote-only.guard';
import { ServiceBridgeController } from './service-bridge.controller';
import { ServiceWorkspaceController } from './service-workspace.controller';
import { ServiceSpaceController } from './service-space.controller';
import { ServicePageController } from './service-page.controller';
import { ServiceContentController } from './service-content.controller';
import { AuthzChangeController } from './authz-change.controller';

// Derived from the module's own registration (not a hand-maintained list) so a controller added to
// ServiceBridgeModule can never escape these assertions. The named imports below pin the KNOWN set: if one
// goes missing from the module, or the module registers something we never reviewed, the sanity check fails.
const KNOWN_CONTROLLERS = [
  ServiceBridgeController,
  ServiceWorkspaceController,
  ServiceSpaceController,
  ServicePageController,
  ServiceContentController,
  AuthzChangeController,
];
const CONTROLLERS = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ServiceBridgeModule) as Array<
  new (...args: any[]) => unknown
>;

const validScopes = new Set<string>(Object.values(ServiceScope));

const routeMethods = (ctrl: any): string[] =>
  Object.getOwnPropertyNames(ctrl.prototype).filter((n) => n !== 'constructor');

/**
 * The intended least-privilege scope for EVERY route, keyed by `Controller.method`. Pinning the exact scope
 * (not just "some valid scope") turns a wrong-scope edit into a failing build. Note the deliberate split:
 * `pages.resolveSpace` is a page-tree lookup (`pages:read`) while `pages.listPermissions` returns an ACL that
 * is part of the `/v1` content read model (`content:read`). Reads and writes are always distinct scopes.
 */
const EXPECTED_SCOPE: Record<string, ServiceScope> = {
  'ServiceBridgeController.provisionUser': ServiceScope.UsersProvision,
  'ServiceBridgeController.resolveUser': ServiceScope.UsersResolve,
  'ServiceBridgeController.mintSession': ServiceScope.SessionMint,
  'ServiceWorkspaceController.getDefault': ServiceScope.WorkspaceRead,
  'ServiceWorkspaceController.getSettings': ServiceScope.WorkspaceRead,
  'ServiceWorkspaceController.updateSettings': ServiceScope.WorkspaceSettingsWrite,
  'ServiceSpaceController.list': ServiceScope.SpacesRead,
  'ServiceSpaceController.getDetail': ServiceScope.SpacesRead,
  'ServiceSpaceController.listMembers': ServiceScope.SpacesRead,
  'ServiceSpaceController.create': ServiceScope.SpacesWrite,
  'ServiceSpaceController.update': ServiceScope.SpacesWrite,
  'ServiceSpaceController.archive': ServiceScope.SpacesWrite,
  'ServiceSpaceController.unarchive': ServiceScope.SpacesWrite,
  'ServiceSpaceController.addMember': ServiceScope.SpacesWrite,
  'ServiceSpaceController.changeMemberRole': ServiceScope.SpacesWrite,
  'ServiceSpaceController.removeMember': ServiceScope.SpacesWrite,
  'ServicePageController.resolveSpace': ServiceScope.PagesRead,
  'ServicePageController.listPermissions': ServiceScope.ContentRead,
  'ServiceContentController.listPages': ServiceScope.ContentRead,
  'ServiceContentController.listSpaces': ServiceScope.ContentRead,
  'ServiceContentController.getSpace': ServiceScope.ContentRead,
  'AuthzChangeController.changes': ServiceScope.ChangesRead,
  'AuthzChangeController.getSnapshot': ServiceScope.ChangesRead,
};

/**
 * Least-privilege is not optional design: EVERY service-bridge route must declare exactly one ServiceScope
 * (the guard 403s a route with no declaration, but this catches it at build time, per route), and EVERY
 * controller must be gated by RemoteOnlyGuard THEN ServiceAuthGuard (mode-off in native, then scoped auth).
 */
describe('service-bridge scope + guard coverage', () => {
  it('the module registers exactly the reviewed controller set', () => {
    expect([...CONTROLLERS].sort((a, b) => a.name.localeCompare(b.name))).toEqual(
      [...KNOWN_CONTROLLERS].sort((a, b) => a.name.localeCompare(b.name)),
    );
  });

  /**
   * Incident #181: the upstream global TransformHttpResponseInterceptor (main.ts) wraps EVERY handler's
   * return value as { data, success, status } unless the HANDLER carries SKIP_TRANSFORM metadata (it reads
   * the handler, never the class). The canonical spec declares bare bodies, so every east-west handler MUST
   * opt out; a new route without @SkipTransform() ships envelope-wrapped and silently breaks the platform.
   */
  it.each(CONTROLLERS.map((c) => [c.name, c] as const))(
    '%s: every route handler carries @SkipTransform() (bare body on the wire, per the spec)',
    (_name, ctrl) => {
      for (const method of routeMethods(ctrl)) {
        expect(Reflect.getMetadata(SKIP_TRANSFORM_KEY, (ctrl as any).prototype[method])).toBe(true);
      }
    },
  );

  it.each(CONTROLLERS.map((c) => [c.name, c] as const))(
    '%s: every route declares exactly the intended least-privilege ServiceScope',
    (name, ctrl) => {
      for (const method of routeMethods(ctrl)) {
        const scope = Reflect.getMetadata(SERVICE_SCOPE_KEY, (ctrl as any).prototype[method]);
        expect(scope).toBeDefined();
        expect(validScopes.has(scope)).toBe(true);
        const key = `${name}.${method}`;
        expect(EXPECTED_SCOPE[key]).toBeDefined(); // a new route must be added to the intended map
        expect(scope).toBe(EXPECTED_SCOPE[key]); // and must carry exactly its intended scope
      }
    },
  );

  it('the intended-scope map has no stale entries (every mapped route still exists)', () => {
    const actual = new Set(
      CONTROLLERS.flatMap((c) => routeMethods(c).map((m) => `${c.name}.${m}`)),
    );
    expect(Object.keys(EXPECTED_SCOPE).filter((k) => !actual.has(k))).toEqual([]);
  });

  it.each(CONTROLLERS.map((c) => [c.name, c] as const))(
    '%s: is gated by RemoteOnlyGuard (first) then ServiceAuthGuard',
    (_name, ctrl) => {
      const guards = Reflect.getMetadata(GUARDS_METADATA, ctrl) as unknown[];
      expect(guards).toBeDefined();
      expect(guards[0]).toBe(RemoteOnlyGuard); // native fails 404 BEFORE the secret is consulted
      expect(guards).toContain(ServiceAuthGuard);
    },
  );

  it('the transitional shared credential grants EXACTLY the defined scopes (no route can out-scope it)', () => {
    const prev = process.env.PLATFORM_AUTHZ_SERVICE_SECRET;
    process.env.PLATFORM_AUTHZ_SERVICE_SECRET = 'test-secret';
    try {
      const guard = new ServiceAuthGuard({ getAllAndOverride: () => undefined } as any);
      const creds = (guard as unknown as { credentials: { scopes: Set<ServiceScope> }[] }).credentials;
      expect(creds).toHaveLength(1);
      expect([...creds[0].scopes].sort()).toEqual([...validScopes].sort());
    } finally {
      if (prev === undefined) delete process.env.PLATFORM_AUTHZ_SERVICE_SECRET;
      else process.env.PLATFORM_AUTHZ_SERVICE_SECRET = prev;
    }
  });
});
