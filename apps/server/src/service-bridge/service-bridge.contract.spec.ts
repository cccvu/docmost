import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PATH_METADATA, METHOD_METADATA, MODULE_METADATA } from '@nestjs/common/constants';
import { ServiceBridgeModule } from './service-bridge.module';
import { RequestMethod } from '@nestjs/common';
import { ServiceBridgeController } from './service-bridge.controller';
import { ServiceWorkspaceController } from './service-workspace.controller';
import { ServiceSpaceController } from './service-space.controller';
import { ServicePageController } from './service-page.controller';
import { ServiceContentController } from './service-content.controller';
import { AuthzChangeController } from './authz-change.controller';
import { CONTENT_LIST_MAX_IDS, CONTENT_LIST_MAX_LIMIT } from './dto/content-read.dto';
import { AuthzChangeEvent, AuthzChangeEventType } from './authz-change-event';
import { ChangesResult } from './authz-change-feed.service';
import { SnapshotResult } from './authz-snapshot.service';
import { PublicPageSummary, PublicSpaceSummary, RawPagePermission } from './service-content.service';
import { SpaceView, RawSpaceMember } from './service-space.service';
import { WorkspaceSettingsView } from './service-workspace.service';

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
) as {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, any> };
};

// Derived from ServiceBridgeModule so a newly registered controller is always compared against the spec.
const CONTROLLERS = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ServiceBridgeModule) as Array<
  new (...args: any[]) => unknown
>;
// The reviewed set (kept as imports so a removal from the module is a visible diff here too).
void [ServiceBridgeController, ServiceWorkspaceController, ServiceSpaceController, ServicePageController, ServiceContentController, AuthzChangeController];

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

  // The content-list caps are enforced in three places (the fork DTO decorators, the OpenAPI request schema,
  // and — on the platform side — content.maxListAuthorizedIds). A silent divergence is exactly what shipped
  // the /v1 regression this guard exists to prevent: the DTO said 1000 while the platform forwarded up to
  // 10000, so a well-authorized principal got a 400. Bind the DTO caps to the canonical spec here; the
  // platform consumer contract test guards its side against the same spec.
  it('the content-list caps match the canonical spec (no silent DTO/spec cap drift)', () => {
    const req = SPEC.components.schemas.ContentListRequest.properties;
    expect(req.ids.maxItems).toBe(CONTENT_LIST_MAX_IDS);
    expect(req.limit.maximum).toBe(CONTENT_LIST_MAX_LIMIT);
  });

  // ---- Feed-schema tether, provider half (issue #179) -----------------------------------------------------
  // The fork's typed change feed (every `AuthzChangeEvent` variant, and `ChangesResult` / `SnapshotResult` as
  // the controller returns them) vs what this document DECLARES in `components.schemas`. The key maps are typed
  // against the fork's own types (`Record<keyof T, true>` + excess-property checks), so a fork-side rename
  // fails to COMPILE and a document-side rename fails the closed-set comparison: a renamed wire key cannot pass
  // from either direction. The platform's consumer contract test pins its client types to the same document,
  // so the two halves close the loop through the document.
  type KeysOf<T extends AuthzChangeEventType> = Record<keyof Extract<AuthzChangeEvent, { type: T }>, true>;
  const FORK_EVENT_KEYS: { [T in AuthzChangeEventType]: KeysOf<T> } = {
    SpaceChanged: { seq: true, type: true, spaceId: true, workspaceId: true, deleted: true },
    SpaceMemberChanged: { seq: true, type: true, spaceId: true, userId: true, groupId: true, role: true, removed: true },
    GroupMemberChanged: { seq: true, type: true, groupId: true, userId: true, removed: true },
    PageStructureChanged: { seq: true, type: true, pageId: true, spaceId: true, parentPageId: true, deleted: true },
    PageRestrictionChanged: { seq: true, type: true, pageId: true, restricted: true },
    PagePermissionChanged: { seq: true, type: true, pageId: true, userId: true, groupId: true, role: true, removed: true },
  };
  const FORK_CHANGES_KEYS: Record<keyof ChangesResult, true> = { events: true, nextCursor: true, head: true, oldestPendingAgeMs: true };
  const FORK_SNAPSHOT_KEYS: Record<keyof SnapshotResult, true> = { events: true, nextCursor: true, baseline: true };
  const sortedKeys = (o: object): string[] => Object.keys(o).sort();

  /** `properties` as a closed key set, and `required` (when declared) as the same set. */
  const closedKeys = (schema: any, expected: string[]): void => {
    expect(schema.additionalProperties).toBe(false); // closed: a renamed key is a removed key, never an extra
    expect(sortedKeys(schema.properties)).toEqual(expected);
    if (schema.required) expect([...schema.required].sort()).toEqual(expected);
  };

  it('#179 tether (provider): every AuthzChangeEvent variant in the document has exactly the keys the fork type emits (closed set)', () => {
    const variants: any[] = SPEC.components.schemas.AuthzChangeEvent.oneOf;
    const documentKeys: Record<string, string[]> = {};
    for (const v of variants) {
      expect(v.additionalProperties).toBe(false);
      if (v.required) expect([...v.required].sort()).toEqual(sortedKeys(v.properties));
      documentKeys[v.properties.type.const] = sortedKeys(v.properties);
    }
    const forkKeys = Object.fromEntries(Object.entries(FORK_EVENT_KEYS).map(([t, k]) => [t, sortedKeys(k)]));
    expect(documentKeys).toEqual(forkKeys);
  });

  it('#179 tether (provider): the changes and snapshot response schemas have exactly the keys the controller returns', () => {
    closedKeys(SPEC.components.schemas.AuthzChangesResponse, sortedKeys(FORK_CHANGES_KEYS));
    closedKeys(SPEC.components.schemas.AuthzSnapshotResponse, sortedKeys(FORK_SNAPSHOT_KEYS));
  });
});

/**
 * Response-body schema tether (issue #174 remainder). C.4 (#179) tethered only the two feed responses; this
 * extends the SAME typed-key-map tether to the 16 body-bearing `/api/service/*` operations, so a renamed or
 * dropped field in any 2xx response schema fails a test from BOTH directions: a fork-type rename fails to
 * COMPILE (the `keysOf<T>(...)` maps below stop matching `keyof T`), and a document-side rename fails the
 * key-set comparison. The 7 reusable component schemas are all-required but not `additionalProperties:false`,
 * so their tether pins `properties` + `required` equality (the closure the feed responses get from AP:false).
 * The 5 inline scalar bodies and the wrapper shapes (array-of, `{ items: array-of }`) are pinned by walking
 * each operation's 2xx body, which also proves the operation points at the RIGHT schema.
 *
 * Scope: this pins key SETS (property presence, closedness, required) so a renamed/dropped/added field is
 * caught. It does NOT validate per-field value TYPES or formats of a live body; that (a real HTTP response
 * conforming field-by-field) is the job of the contract-replacement smoke, not this structural spec.
 */
describe('service-bridge.openapi.json 2xx response bodies match the fork return types (provider side, #174)', () => {
  const sortedKeys = (o: object): string[] => Object.keys(o).sort();
  /** Sorted key list of a `Record<keyof T, true>` literal: a missing key (Record) or an extra key (excess
   *  property) is a COMPILE error, so the list always tracks the fork type exactly. */
  const keysOf = <T,>(m: Record<keyof T, true>): string[] => Object.keys(m).sort();

  // The 7 reusable named response schemas, tied to the fork interfaces the controllers actually return.
  const NAMED: Record<string, string[]> = {
    ProvisionedUser: keysOf<Awaited<ReturnType<ServiceBridgeController['resolveUser']>>>({ userId: true, workspaceId: true }),
    WorkspaceSettings: keysOf<WorkspaceSettingsView>({ name: true, defaultPageEditMode: true }),
    SpaceView: keysOf<SpaceView>({ id: true, name: true, slug: true, description: true, visibility: true, memberCount: true, archived: true, createdAt: true }),
    RawSpaceMember: keysOf<RawSpaceMember>({ memberId: true, userId: true, groupId: true, role: true, createdAt: true }),
    PublicPageSummary: keysOf<PublicPageSummary>({ id: true, slugId: true, title: true, icon: true, spaceId: true, parentPageId: true, position: true, createdAt: true, updatedAt: true }),
    PublicSpaceSummary: keysOf<PublicSpaceSummary>({ id: true, name: true, slug: true, description: true, visibility: true, createdAt: true, updatedAt: true }),
    RawPagePermission: keysOf<RawPagePermission>({ id: true, userId: true, groupId: true, role: true, createdAt: true }),
  };

  // The 5 inline (non-component) scalar bodies, tied to the CONTROLLER return types (a signature change reds).
  const MINT = keysOf<Awaited<ReturnType<ServiceBridgeController['mintSession']>>>({ ok: true });
  const DEFAULT_WS = keysOf<Awaited<ReturnType<ServiceWorkspaceController['getDefault']>>>({ workspaceId: true });
  const CREATE_SPACE = keysOf<Awaited<ReturnType<ServiceSpaceController['create']>>>({ id: true, slug: true, name: true });
  const ADD_MEMBER = keysOf<Awaited<ReturnType<ServiceSpaceController['addMember']>>>({ memberId: true, userId: true });
  const RESOLVE_PAGE_SPACE = keysOf<Awaited<ReturnType<ServicePageController['resolveSpace']>>>({ pageId: true, spaceId: true });

  type OpExpect =
    | { kind: 'ref'; name: string }
    | { kind: 'array'; name: string }
    | { kind: 'items'; name: string }
    | { kind: 'inline'; keys: string[] };

  const OPS: Array<{ id: string; method: string; path: string; expect: OpExpect }> = [
    { id: 'provisionShadowUser', method: 'post', path: '/api/service/users', expect: { kind: 'ref', name: 'ProvisionedUser' } },
    { id: 'resolveUser', method: 'post', path: '/api/service/users/resolve', expect: { kind: 'ref', name: 'ProvisionedUser' } },
    { id: 'mintSession', method: 'post', path: '/api/service/session', expect: { kind: 'inline', keys: MINT } },
    { id: 'getDefaultWorkspace', method: 'get', path: '/api/service/workspace/default', expect: { kind: 'inline', keys: DEFAULT_WS } },
    { id: 'getWorkspaceSettings', method: 'get', path: '/api/service/workspace/settings', expect: { kind: 'ref', name: 'WorkspaceSettings' } },
    { id: 'updateWorkspaceSettings', method: 'patch', path: '/api/service/workspace/settings', expect: { kind: 'ref', name: 'WorkspaceSettings' } },
    { id: 'listSpaces', method: 'get', path: '/api/service/spaces', expect: { kind: 'array', name: 'SpaceView' } },
    { id: 'createSpace', method: 'post', path: '/api/service/spaces', expect: { kind: 'inline', keys: CREATE_SPACE } },
    { id: 'getSpace', method: 'get', path: '/api/service/spaces/{spaceId}', expect: { kind: 'ref', name: 'SpaceView' } },
    { id: 'listSpaceMembers', method: 'get', path: '/api/service/spaces/{spaceId}/members', expect: { kind: 'array', name: 'RawSpaceMember' } },
    { id: 'addSpaceMember', method: 'post', path: '/api/service/spaces/{spaceId}/members', expect: { kind: 'inline', keys: ADD_MEMBER } },
    { id: 'resolvePageSpace', method: 'post', path: '/api/service/pages/resolve-space', expect: { kind: 'inline', keys: RESOLVE_PAGE_SPACE } },
    { id: 'listPagePermissions', method: 'get', path: '/api/service/pages/{pageId}/permissions', expect: { kind: 'items', name: 'RawPagePermission' } },
    { id: 'listContentPages', method: 'post', path: '/api/service/content/pages/list', expect: { kind: 'items', name: 'PublicPageSummary' } },
    { id: 'listContentSpaces', method: 'post', path: '/api/service/content/spaces/list', expect: { kind: 'items', name: 'PublicSpaceSummary' } },
    { id: 'getContentSpace', method: 'get', path: '/api/service/content/spaces/{spaceId}', expect: { kind: 'ref', name: 'PublicSpaceSummary' } },
  ];

  const refName = (s: any): string | null => (s && typeof s.$ref === 'string' ? s.$ref.split('/').pop()! : null);
  const body2xx = (method: string, path: string): any => {
    const op = (SPEC.paths as any)[path]?.[method];
    expect(op).toBeDefined();
    const code = Object.keys(op.responses).find((c) => c.startsWith('2'));
    return op.responses[code as string].content['application/json'].schema;
  };

  it('every reusable response component schema has exactly the keys its fork type declares (required-closed)', () => {
    for (const [name, keys] of Object.entries(NAMED)) {
      const schema = SPEC.components.schemas[name];
      expect(sortedKeys(schema.properties)).toEqual(keys);
      // All-required is the closure here (these response schemas are not additionalProperties:false), so a
      // renamed/dropped field is caught by the required-set equality as well as the properties comparison.
      expect([...schema.required].sort()).toEqual(keys);
    }
  });

  it.each(OPS)('$id: the 2xx body schema matches the fork return shape', ({ method, path, expect: exp }) => {
    const schema = body2xx(method, path);
    if (exp.kind === 'ref') {
      expect(refName(schema)).toBe(exp.name);
    } else if (exp.kind === 'array') {
      expect(schema.type).toBe('array');
      expect(refName(schema.items)).toBe(exp.name);
    } else if (exp.kind === 'items') {
      expect(sortedKeys(schema.properties)).toEqual(['items']);
      expect(schema.properties.items.type).toBe('array');
      expect(refName(schema.properties.items.items)).toBe(exp.name);
    } else {
      expect(sortedKeys(schema.properties)).toEqual(exp.keys);
      if (schema.required) expect([...schema.required].sort()).toEqual(exp.keys);
    }
  });
});
