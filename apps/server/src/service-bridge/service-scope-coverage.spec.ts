import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ServiceAuthGuard, SERVICE_SCOPE_KEY } from './service-auth.guard';
import { ServiceScope } from './service-scope';
import { RemoteOnlyGuard } from '../authz/mode/remote-only.guard';
import { ServiceBridgeController } from './service-bridge.controller';
import { ServiceWorkspaceController } from './service-workspace.controller';
import { ServiceSpaceController } from './service-space.controller';
import { ServicePageController } from './service-page.controller';
import { ServiceContentController } from './service-content.controller';

const CONTROLLERS = [
  ServiceBridgeController,
  ServiceWorkspaceController,
  ServiceSpaceController,
  ServicePageController,
  ServiceContentController,
];

const validScopes = new Set<string>(Object.values(ServiceScope));

const routeMethods = (ctrl: any): string[] =>
  Object.getOwnPropertyNames(ctrl.prototype).filter((n) => n !== 'constructor');

/**
 * Least-privilege is not optional design: EVERY service-bridge route must declare exactly one ServiceScope
 * (the guard 403s a route with no declaration, but this catches it at build time, per route), and EVERY
 * controller must be gated by RemoteOnlyGuard THEN ServiceAuthGuard (mode-off in native, then scoped auth).
 */
describe('service-bridge scope + guard coverage', () => {
  it.each(CONTROLLERS.map((c) => [c.name, c] as const))(
    '%s: every route declares a valid ServiceScope',
    (_name, ctrl) => {
      for (const method of routeMethods(ctrl)) {
        const scope = Reflect.getMetadata(SERVICE_SCOPE_KEY, (ctrl as any).prototype[method]);
        expect(scope).toBeDefined();
        expect(validScopes.has(scope)).toBe(true);
      }
    },
  );

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
