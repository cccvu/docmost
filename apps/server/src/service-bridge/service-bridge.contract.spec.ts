import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { ServiceBridgeController } from './service-bridge.controller';
import { ServiceWorkspaceController } from './service-workspace.controller';
import { ServiceSpaceController } from './service-space.controller';
import { ServicePageController } from './service-page.controller';
import { ServiceContentController } from './service-content.controller';

/**
 * Provider-side contract test: the routes the fork actually implements MUST equal the operations declared in
 * the canonical inbound spec `service-bridge.openapi.json`. It derives from the spec (no duplicated fixture),
 * so adding/removing/renaming a route without updating the spec (or vice-versa) fails the build — the same
 * drift guard the outbound consumer/provider specs give the authorization-service contract.
 *
 * Scope: the `/api/service/*` surface. `/api/collab/force-disconnect` lives in a separate module whose
 * controller transitively imports the collaboration/lib0 ESM graph (unloadable under jest), so it is covered
 * by `authz/collab/collab-disconnect.controller.spec.ts`, not here; it is filtered out of the comparison.
 */
const SPEC = JSON.parse(
  readFileSync(
    join(__dirname, '../../../../docs/integrations/authorization/service-bridge.openapi.json'),
    'utf8',
  ),
) as { paths: Record<string, Record<string, unknown>> };

const CONTROLLERS = [
  ServiceBridgeController,
  ServiceWorkspaceController,
  ServiceSpaceController,
  ServicePageController,
  ServiceContentController,
];

const METHOD_NAME: Record<number, string> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.DELETE]: 'delete',
  [RequestMethod.PATCH]: 'patch',
};

// `:spaceId` (Nest) <-> `{spaceId}` (OpenAPI); normalise both to `{spaceId}`.
const norm = (p: string) => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}').replace(/\/+$/, '');

function implementedRoutes(): Set<string> {
  const routes = new Set<string>();
  for (const ctrl of CONTROLLERS) {
    const prefix = (Reflect.getMetadata(PATH_METADATA, ctrl) as string) ?? '';
    for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
      if (name === 'constructor') continue;
      const handler = (ctrl as any).prototype[name];
      const sub = Reflect.getMetadata(PATH_METADATA, handler);
      const method = Reflect.getMetadata(METHOD_METADATA, handler);
      if (sub === undefined || method === undefined) continue;
      const path = norm(`/api/${prefix}/${sub}`.replace(/\/+/g, '/'));
      routes.add(`${METHOD_NAME[method]} ${path}`);
    }
  }
  return routes;
}

function specRoutes(): Set<string> {
  const routes = new Set<string>();
  for (const [path, ops] of Object.entries(SPEC.paths)) {
    if (!path.startsWith('/api/service/')) continue; // collab is covered by its own spec (see header)
    for (const method of Object.keys(ops)) {
      if (method === 'parameters') continue; // path-level params, not an operation
      routes.add(`${method} ${norm(path)}`);
    }
  }
  return routes;
}

describe('service-bridge.openapi.json is the canonical inbound contract (provider side)', () => {
  it('every implemented route is declared in the spec (no undocumented endpoint)', () => {
    const spec = specRoutes();
    const undocumented = [...implementedRoutes()].filter((r) => !spec.has(r));
    expect(undocumented).toEqual([]);
  });

  it('every spec operation is actually implemented (no phantom endpoint)', () => {
    const impl = implementedRoutes();
    const unimplemented = [...specRoutes()].filter((r) => !impl.has(r));
    expect(unimplemented).toEqual([]);
  });
});
