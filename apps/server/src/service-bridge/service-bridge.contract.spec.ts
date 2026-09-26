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
import { ServiceAttachmentController } from './service-attachment.controller';
import { AuthzChangeController } from './authz-change.controller';
import { CONTENT_LIST_MAX_IDS, CONTENT_LIST_MAX_LIMIT } from './dto/content-read.dto';
import { AuthzChangeEvent, AuthzChangeEventType } from './authz-change-event';
import { ChangesResult } from './authz-change-feed.service';
import { SnapshotResult } from './authz-snapshot.service';
import {
  PagePermissionsResult,
  PublicPageSummary,
  PublicSpaceDetail,
  PublicSpaceSummary,
  RawPagePermission,
} from './service-content.service';
import { PublicSearchHit } from './service-search.service';
import { PublicAttachmentSummary } from './service-attachment.service';
import { SpaceView, RawSpaceMember, SpaceDetailView, SpaceMemberPreview } from './service-space.service';
import { WorkspaceSettingsView } from './service-workspace.service';
import { ShadowUserLookup } from './service-bridge.service';
import {
  CreateSpaceDto,
  ExpectedVersionDto,
  SpaceMemberPreviewDto,
  UpdateSpaceDto,
  UpdateSpaceMemberDto,
} from './dto/space-admin.dto';
import { MAX_EXPECTED_VERSION_LENGTH } from './resource-version';
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_NAMESPACE_MAX_LENGTH,
  REQUEST_FINGERPRINT_PATTERN,
} from '../authz/idempotency/idempotency-ledger.service';
import { DescendantFacts, LifecycleTarget, PageLifecycleState, TrashedPageRow } from './service-page-lifecycle.service';
import { PageAuthzState, PageAuthzStateResult } from './page-authz-state.service';
import { PAGE_AUTHZ_STATE_MAX, PageAuthzStateDto } from './dto/page-authz-state.dto';
import {
  PAGE_IMPORT_FORMATS,
  PAGE_IMPORT_MAX_ITEMS,
  PAGE_IMPORT_TITLE_MAX_LENGTH,
  TitleCandidatesDto,
  ValidateContentDto,
  ValidateContentItemDto,
} from './dto/page-import.dto';
import { TitleCandidate } from './service-page-import.service';

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
void [ServiceBridgeController, ServiceWorkspaceController, ServiceSpaceController, ServicePageController, ServiceContentController, ServiceAttachmentController, AuthzChangeController];

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

  // #330: the mint request carries the platform-resolved client IP. The endpoint accepts an undeclared body
  // field silently (whitelist strips it), so without pinning the schema the contract could quietly forbid the
  // field the fork now reads (the #320 step-6b "prose to CI" trap). Assert the schema declares it (closed set)
  // AND the request example exercises it within the DTO's bound.
  it('#330: MintSessionRequest declares the optional clientIp and the example exercises it', () => {
    const schema = SPEC.components.schemas.MintSessionRequest;
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual(['clientIp', 'externalId']);
    expect(schema.required).toEqual(['externalId']); // clientIp is optional
    expect(SPEC.components.schemas.ClientIp.maxLength).toBe(45); // matches MintSessionDto @MaxLength(45)
    const example = (SPEC.paths['/api/service/session'] as any).post.requestBody.content[
      'application/json'
    ].example;
    expect(typeof example.clientIp).toBe('string');
    expect(example.clientIp.length).toBeLessThanOrEqual(45);
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
  const FORK_CHANGES_KEYS: Record<keyof ChangesResult, true> = { events: true, nextCursor: true, head: true, oldestPendingAgeMs: true, dropped: true };
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
    RawSpaceMember: keysOf<RawSpaceMember>({ memberId: true, userId: true, groupId: true, role: true, createdAt: true, version: true }),
    // #616: the detail reads carry the space version; the ACL read carries `restricted` + the ACL version.
    SpaceDetail: keysOf<SpaceDetailView>({ id: true, name: true, slug: true, description: true, visibility: true, memberCount: true, archived: true, createdAt: true, version: true }),
    PublicSpaceDetail: keysOf<PublicSpaceDetail>({ id: true, name: true, slug: true, description: true, visibility: true, createdAt: true, updatedAt: true, version: true }),
    PagePermissions: keysOf<PagePermissionsResult>({ items: true, restricted: true, version: true }),
    PublicPageSummary: keysOf<PublicPageSummary>({ id: true, slugId: true, title: true, icon: true, spaceId: true, parentPageId: true, position: true, createdAt: true, updatedAt: true }),
    PublicSpaceSummary: keysOf<PublicSpaceSummary>({ id: true, name: true, slug: true, description: true, visibility: true, createdAt: true, updatedAt: true }),
    RawPagePermission: keysOf<RawPagePermission>({ id: true, userId: true, groupId: true, role: true, createdAt: true }),
    PublicSearchHit: keysOf<PublicSearchHit>({ id: true, title: true, icon: true, parentPageId: true, space: true, highlight: true, createdAt: true, updatedAt: true }),
    PublicAttachmentSummary: keysOf<PublicAttachmentSummary>({ id: true, fileName: true, mimeType: true, fileSize: true, type: true, createdAt: true }),
    ShadowUserLookup: keysOf<ShadowUserLookup>({ externalId: true, userId: true }),
    // #485 lifecycle facts. (PageLifecycleState itself has one OPTIONAL key, so it is pinned separately below.)
    PageLifecycleTarget: keysOf<LifecycleTarget>({ parentPageId: true, exists: true, spaceId: true, deletedAt: true, restrictedLineageIds: true, lineageComplete: true, isSelfOrDescendant: true, nextPosition: true }),
    TrashedPage: keysOf<TrashedPageRow>({ id: true, title: true, icon: true, parentPageId: true, deletedAt: true, deletedBy: true }),
    // #545 page authz state.
    PageAuthzState: keysOf<PageAuthzState>({ pageId: true, exists: true, spaceId: true, parentPageId: true, restricted: true, lineageRestricted: true, lineageComplete: true }),
    PageAuthzStateResponse: keysOf<PageAuthzStateResult>({ pages: true, nextAfter: true }),
  };

  // The 5 inline (non-component) scalar bodies, tied to the CONTROLLER return types (a signature change reds).
  const MINT = keysOf<Awaited<ReturnType<ServiceBridgeController['mintSession']>>>({ ok: true });
  const REVOKE = keysOf<Awaited<ReturnType<ServiceBridgeController['revokeSession']>>>({ userId: true, deactivated: true, sessionsRevoked: true });
  const RESTORE = keysOf<Awaited<ReturnType<ServiceBridgeController['restoreSession']>>>({ reactivated: true });
  const DEFAULT_WS = keysOf<Awaited<ReturnType<ServiceWorkspaceController['getDefault']>>>({ workspaceId: true });
  // #616: `replayed` is present only on a keyed create, so it is the one optional key.
  const CREATE_SPACE = keysOf<Awaited<ReturnType<ServiceSpaceController['create']>>>({ id: true, slug: true, name: true, replayed: true });
  const ADD_MEMBER = keysOf<Awaited<ReturnType<ServiceSpaceController['addMember']>>>({ memberId: true, userId: true, version: true });
  const RESOLVE_PAGE_SPACE = keysOf<Awaited<ReturnType<ServicePageController['resolveSpace']>>>({ pageId: true, spaceId: true });
  const RESOLVE_ATTACHMENT_PAGE = keysOf<Awaited<ReturnType<ServiceAttachmentController['resolvePage']>>>({ attachmentId: true, pageId: true, spaceId: true });
  // #616 import helpers (their item shapes are pinned in the #616 import-helper block below).
  const VALIDATE_CONTENT = keysOf<Awaited<ReturnType<ServicePageController['validateContent']>>>({ results: true });
  const TITLE_CANDIDATES = keysOf<Awaited<ReturnType<ServicePageController['titleCandidates']>>>({ matches: true });

  type OpExpect =
    | { kind: 'ref'; name: string }
    | { kind: 'array'; name: string }
    | { kind: 'items'; name: string }
    | { kind: 'inline'; keys: string[]; optional?: string[] };

  const OPS: Array<{ id: string; method: string; path: string; expect: OpExpect }> = [
    { id: 'provisionShadowUser', method: 'post', path: '/api/service/users', expect: { kind: 'ref', name: 'ProvisionedUser' } },
    { id: 'resolveUser', method: 'post', path: '/api/service/users/resolve', expect: { kind: 'ref', name: 'ProvisionedUser' } },
    { id: 'lookupUsers', method: 'post', path: '/api/service/users/lookup', expect: { kind: 'items', name: 'ShadowUserLookup' } },
    { id: 'mintSession', method: 'post', path: '/api/service/session', expect: { kind: 'inline', keys: MINT } },
    { id: 'revokeSession', method: 'post', path: '/api/service/session/revoke', expect: { kind: 'inline', keys: REVOKE } },
    { id: 'restoreSession', method: 'post', path: '/api/service/session/restore', expect: { kind: 'inline', keys: RESTORE } },
    { id: 'getDefaultWorkspace', method: 'get', path: '/api/service/workspace/default', expect: { kind: 'inline', keys: DEFAULT_WS } },
    { id: 'getWorkspaceSettings', method: 'get', path: '/api/service/workspace/settings', expect: { kind: 'ref', name: 'WorkspaceSettings' } },
    { id: 'updateWorkspaceSettings', method: 'patch', path: '/api/service/workspace/settings', expect: { kind: 'ref', name: 'WorkspaceSettings' } },
    { id: 'listSpaces', method: 'get', path: '/api/service/spaces', expect: { kind: 'array', name: 'SpaceView' } },
    { id: 'createSpace', method: 'post', path: '/api/service/spaces', expect: { kind: 'inline', keys: CREATE_SPACE, optional: ['replayed'] } },
    { id: 'getSpace', method: 'get', path: '/api/service/spaces/{spaceId}', expect: { kind: 'ref', name: 'SpaceDetail' } },
    { id: 'listSpaceMembers', method: 'get', path: '/api/service/spaces/{spaceId}/members', expect: { kind: 'array', name: 'RawSpaceMember' } },
    { id: 'addSpaceMember', method: 'post', path: '/api/service/spaces/{spaceId}/members', expect: { kind: 'inline', keys: ADD_MEMBER } },
    { id: 'resolvePageSpace', method: 'post', path: '/api/service/pages/resolve-space', expect: { kind: 'inline', keys: RESOLVE_PAGE_SPACE } },
    { id: 'listPagePermissions', method: 'get', path: '/api/service/pages/{pageId}/permissions', expect: { kind: 'ref', name: 'PagePermissions' } },
    { id: 'listContentPages', method: 'post', path: '/api/service/content/pages/list', expect: { kind: 'items', name: 'PublicPageSummary' } },
    { id: 'listContentSpaces', method: 'post', path: '/api/service/content/spaces/list', expect: { kind: 'items', name: 'PublicSpaceSummary' } },
    { id: 'getContentSpace', method: 'get', path: '/api/service/content/spaces/{spaceId}', expect: { kind: 'ref', name: 'PublicSpaceDetail' } },
    { id: 'previewSpaceMember', method: 'post', path: '/api/service/spaces/{spaceId}/members/preview', expect: { kind: 'ref', name: 'SpaceMemberPreview' } },
    { id: 'searchContent', method: 'post', path: '/api/service/content/search', expect: { kind: 'items', name: 'PublicSearchHit' } },
    { id: 'resolveAttachmentPage', method: 'get', path: '/api/service/attachments/{attachmentId}/page', expect: { kind: 'inline', keys: RESOLVE_ATTACHMENT_PAGE } },
    { id: 'listPageAttachments', method: 'get', path: '/api/service/attachments/by-page/{pageId}', expect: { kind: 'items', name: 'PublicAttachmentSummary' } },
    { id: 'pageLifecycleState', method: 'post', path: '/api/service/pages/lifecycle-state', expect: { kind: 'ref', name: 'PageLifecycleState' } },
    { id: 'listTrashedPages', method: 'post', path: '/api/service/pages/trash', expect: { kind: 'items', name: 'TrashedPage' } },
    { id: 'getPageAuthzState', method: 'post', path: '/api/service/authz/pages/state', expect: { kind: 'ref', name: 'PageAuthzStateResponse' } },
    { id: 'validateImportContent', method: 'post', path: '/api/service/pages/validate-content', expect: { kind: 'inline', keys: VALIDATE_CONTENT } },
    { id: 'pageTitleCandidates', method: 'post', path: '/api/service/pages/title-candidates', expect: { kind: 'inline', keys: TITLE_CANDIDATES } },
  ];

  // #545: the request is typed against the DTO (a field added on either side fails) and its caps are the DTO's.
  it('PageAuthzStateRequest declares exactly the DTO keys, none required, with the DTO caps', () => {
    const schema = SPEC.components.schemas.PageAuthzStateRequest;
    expect(sortedKeys(schema.properties)).toEqual(
      keysOf<PageAuthzStateDto>({ pageIds: true, subtreeRootId: true, after: true, limit: true }),
    );
    expect(schema.required).toBeUndefined();
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.pageIds.maxItems).toBe(PAGE_AUTHZ_STATE_MAX);
    expect(schema.properties.limit.maximum).toBe(PAGE_AUTHZ_STATE_MAX);
  });

  // #485: `target` is present only when the request named one, so it is the one non-required key.
  it('PageLifecycleState has exactly the fork type’s keys, all required but the optional `target`', () => {
    const schema = SPEC.components.schemas.PageLifecycleState;
    const keys = keysOf<PageLifecycleState>({ pageId: true, spaceId: true, parentPageId: true, position: true, deletedAt: true, parent: true, restrictedAncestorIds: true, ancestorsComplete: true, selfRestricted: true, descendants: true, target: true });
    expect(sortedKeys(schema.properties)).toEqual(keys);
    expect([...schema.required].sort()).toEqual(keys.filter((k) => k !== 'target'));
    expect(sortedKeys(schema.properties.descendants.properties)).toEqual(
      keysOf<DescendantFacts>({ restricted: true, trashed: true, crossSpace: true, complete: true }),
    );
    expect(refName(schema.properties.target)).toBe('PageLifecycleTarget');
  });

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
      if (schema.required) expect([...schema.required].sort()).toEqual(exp.keys.filter((k) => !exp.optional?.includes(k)));
    }
  });
});

/**
 * #486 — the member-mutation refusals are part of the wire contract the platform maps by status + body: the
 * last-admin 409 on add/re-role/remove, the restore 409, the rule-M 403 whose body carries `code: self_grant`
 * (the only error `code` the document makes contractual), and the re-role's REQUIRED actor. The request key
 * set is typed against the fork DTO, so a field added on either side fails from both directions.
 */
describe('service-bridge.openapi.json member-mutation refusals (#486)', () => {
  const op = (path: string, method: string): any => (SPEC.paths as any)[path][method];
  const responses = (SPEC as any).components.responses;
  const refName = (r: any): string => String(r?.$ref ?? '').split('/').pop()!;
  const MEMBERS = '/api/service/spaces/{spaceId}/members';
  const MEMBER = '/api/service/spaces/{spaceId}/members/{memberId}';

  it('declares a 409 on add / re-role / remove member (last admin) and on unarchive (personal space)', () => {
    expect(refName(op(MEMBERS, 'post').responses['409'])).toBe('LastAdmin');
    expect(refName(op(MEMBER, 'patch').responses['409'])).toBe('LastAdmin');
    expect(refName(op(MEMBER, 'delete').responses['409'])).toBe('LastAdmin');
    expect(refName(op('/api/service/spaces/{spaceId}/unarchive', 'post').responses['409'])).toBe('Conflict');
    expect(responses.LastAdmin).toBeDefined();
  });

  it('the add / re-role 403 admits the self_grant body (and still the scope-denial body)', () => {
    for (const o of [op(MEMBERS, 'post'), op(MEMBER, 'patch')]) {
      expect(refName(o.responses['403'])).toBe('MemberWriteForbidden');
    }
    const branches = responses.MemberWriteForbidden.content['application/json'].schema.anyOf.map(refName);
    expect(branches.sort()).toEqual(['Error', 'SelfGrantError']);
    const selfGrant = SPEC.components.schemas.SelfGrantError;
    expect(selfGrant.properties.code.const).toBe('self_grant');
    expect([...selfGrant.required].sort()).toEqual(['code', 'message']);
  });

  it('UpdateSpaceMemberRequest requires exactly the DTO keys — actorExternalId included (rule M fails closed)', () => {
    const keys = Object.keys({ role: true, actorExternalId: true, expectedVersion: true } satisfies Record<keyof UpdateSpaceMemberDto, true>).sort();
    const schema = SPEC.components.schemas.UpdateSpaceMemberRequest;
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual(keys);
    // #616: the compare is optional; the actor is not.
    expect([...schema.required].sort()).toEqual(keys.filter((k) => k !== 'expectedVersion'));
  });
});

/**
 * #616 Stage 2 — versions, atomic compares and the member preview are part of the wire contract: the request keys are
 * typed against the fork DTOs (a field added on either side fails), the compared writes declare their 412 and the
 * retryable `engine_busy` 503, and the preview's body is pinned key for key.
 */
describe('service-bridge.openapi.json versions + member preview (#616)', () => {
  const S = SPEC as any;
  const op = (path: string, method: string): any => S.paths[path][method];
  const refName = (r: any): string => String(r?.$ref ?? '').split('/').pop()!;
  const sorted = (o: object): string[] => Object.keys(o).sort();
  const keysOf = <T,>(m: Record<keyof T, true>): string[] => Object.keys(m).sort();
  const SPACE = '/api/service/spaces/{spaceId}';
  const MEMBER = '/api/service/spaces/{spaceId}/members/{memberId}';

  it('ExpectedVersion is the DTO bound; Version is 64 hex', () => {
    expect(S.components.schemas.ExpectedVersion.maxLength).toBe(MAX_EXPECTED_VERSION_LENGTH);
    expect(S.components.schemas.ExpectedVersion.minLength).toBe(1);
    expect(S.components.schemas.Version.pattern).toBe('^[0-9a-f]{64}$');
  });

  it('the request schemas carry exactly the DTO keys (expectedVersion optional everywhere)', () => {
    const update = S.components.schemas.UpdateSpaceRequest;
    expect(sorted(update.properties)).toEqual(keysOf<UpdateSpaceDto>({ name: true, description: true, expectedVersion: true }));
    expect(update.required).toBeUndefined();
    const bare = S.components.schemas.ExpectedVersionRequest;
    expect(bare.additionalProperties).toBe(false);
    expect(sorted(bare.properties)).toEqual(keysOf<ExpectedVersionDto>({ expectedVersion: true }));
    expect(bare.required).toBeUndefined();
    const preview = S.components.schemas.SpaceMemberPreviewRequest;
    expect(preview.additionalProperties).toBe(false);
    expect(sorted(preview.properties)).toEqual(
      keysOf<SpaceMemberPreviewDto>({ action: true, externalId: true, addedByExternalId: true, memberId: true, role: true, actorExternalId: true, expectedVersion: true }),
    );
    expect(preview.required).toEqual(['action']);
    expect(preview.properties.action.enum).toEqual(['add', 'update', 'remove']);
  });

  it('archive and member removal take an OPTIONAL ExpectedVersionRequest body (none = the pre-#616 request)', () => {
    for (const o of [op(`${SPACE}/archive`, 'post'), op(MEMBER, 'delete')]) {
      expect(o.requestBody.required).toBe(false);
      expect(refName(o.requestBody.content['application/json'].schema)).toBe('ExpectedVersionRequest');
    }
  });

  it('every compared write declares 412 PreconditionFailed and the retryable engine_busy 503', () => {
    for (const o of [op(SPACE, 'patch'), op(`${SPACE}/archive`, 'post'), op(MEMBER, 'patch'), op(MEMBER, 'delete')]) {
      expect(refName(o.responses['412'])).toBe('PreconditionFailed');
      expect(refName(o.responses['503'])).toBe('UnconfiguredOrBusy');
    }
    expect(S.components.schemas.PreconditionFailedError.properties.code.const).toBe('precondition_failed');
    expect(S.components.schemas.EngineBusyError.properties.code.const).toBe('engine_busy');
    const busy = S.components.responses.UnconfiguredOrBusy.content['application/json'].schema.anyOf.map(refName);
    expect(busy.sort()).toEqual(['EngineBusyError', 'Error']);
  });

  it('rename / archive / role change answer the new version (the narrowing ones keep Authz-Propagation)', () => {
    expect(refName(op(SPACE, 'patch').responses['200'])).toBe('OkVersioned');
    expect(refName(op(`${SPACE}/archive`, 'post').responses['200'])).toBe('OkVersionedNarrowing');
    expect(refName(op(MEMBER, 'patch').responses['200'])).toBe('OkVersionedNarrowing');
    const UPDATE = keysOf<Awaited<ReturnType<ServiceSpaceController['update']>>>({ ok: true, version: true });
    const ARCHIVE = keysOf<Awaited<ReturnType<ServiceSpaceController['archive']>>>({ ok: true, version: true });
    const ROLE = keysOf<Awaited<ReturnType<ServiceSpaceController['changeMemberRole']>>>({ ok: true, version: true });
    for (const [name, keys] of [['OkVersioned', UPDATE], ['OkVersionedNarrowing', ARCHIVE], ['OkVersionedNarrowing', ROLE]] as const) {
      const schema = S.components.responses[name].content['application/json'].schema;
      expect(sorted(schema.properties)).toEqual(keys);
      expect([...schema.required].sort()).toEqual(keys);
    }
    expect(S.components.responses.OkVersionedNarrowing.headers['Authz-Propagation']).toBeDefined();
  });

  it('SpaceMemberPreview has exactly the fork type keys (code optional), its effect too, and the refusal codes', () => {
    const schema = S.components.schemas.SpaceMemberPreview;
    const keys = keysOf<SpaceMemberPreview>({ outcome: true, code: true, version: true, effect: true });
    expect(schema.additionalProperties).toBe(false);
    expect(sorted(schema.properties)).toEqual(keys);
    expect([...schema.required].sort()).toEqual(keys.filter((k) => k !== 'code'));
    expect(schema.properties.outcome.enum).toEqual(['would_apply', 'noop', 'refused']);
    expect([...schema.properties.code.enum].sort()).toEqual(
      ['last_admin', 'member_not_found', 'precondition_failed', 'self_grant', 'space_archived'],
    );
    const effect = schema.properties.effect;
    const effectKeys = keysOf<SpaceMemberPreview['effect']>({ roleBefore: true, roleAfter: true, provisionsAccount: true });
    expect(sorted(effect.properties)).toEqual(effectKeys);
    expect([...effect.required].sort()).toEqual(effectKeys);
  });
});

/**
 * #616 Stage 3 — the keyed space create is part of the wire contract: the request keys are typed against the fork DTO
 * (a field added on either side fails), the three keyed fields are optional but all-or-none (`dependentRequired`, the
 * DTO's `ValidateIf`), their bounds are the ledger's, and the refusals the platform maps by code are declared.
 */
describe('service-bridge.openapi.json keyed space create (#616)', () => {
  const S = SPEC as any;
  const create = S.paths['/api/service/spaces'].post;
  const refName = (r: any): string => String(r?.$ref ?? '').split('/').pop()!;
  const keysOf = <T,>(m: Record<keyof T, true>): string[] => Object.keys(m).sort();
  const KEYED = ['idempotencyKey', 'idempotencyNamespace', 'fingerprint'];

  it('CreateSpaceRequest carries exactly the DTO keys; only name + creatorExternalId are required', () => {
    const schema = S.components.schemas.CreateSpaceRequest;
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual(
      keysOf<CreateSpaceDto>({ name: true, slug: true, description: true, creatorExternalId: true, idempotencyKey: true, idempotencyNamespace: true, fingerprint: true }),
    );
    expect([...schema.required].sort()).toEqual(['creatorExternalId', 'name']);
  });

  it('the three keyed fields are all-or-none, with the ledger bounds', () => {
    const schema = S.components.schemas.CreateSpaceRequest;
    for (const k of KEYED) expect([...schema.dependentRequired[k]].sort()).toEqual(KEYED.filter((x) => x !== k).sort());
    expect(schema.properties.idempotencyKey).toMatchObject({ minLength: 1, maxLength: IDEMPOTENCY_KEY_MAX_LENGTH });
    expect(schema.properties.idempotencyNamespace).toMatchObject({ minLength: 1, maxLength: IDEMPOTENCY_NAMESPACE_MAX_LENGTH });
    expect(schema.properties.fingerprint.pattern).toBe(REQUEST_FINGERPRINT_PATTERN.source);
  });

  it('declares the keyed refusals by code: 409 idempotency_key_reused, 404 idempotency_resource_gone, 503 engine_busy', () => {
    expect(refName(create.responses['409'])).toBe('CreateSpaceConflict');
    expect(refName(create.responses['404'])).toBe('IdempotentResourceGone');
    expect(refName(create.responses['503'])).toBe('UnconfiguredOrBusy');
    const branches = (r: string) => S.components.responses[r].content['application/json'].schema.anyOf.map(refName).sort();
    expect(branches('CreateSpaceConflict')).toEqual(['Error', 'IdempotencyKeyReusedError']);
    expect(branches('IdempotentResourceGone')).toEqual(['Error', 'IdempotencyResourceGoneError']);
    expect(S.components.schemas.IdempotencyKeyReusedError.properties.code.const).toBe('idempotency_key_reused');
    expect(S.components.schemas.IdempotencyResourceGoneError.properties.code.const).toBe('idempotency_resource_gone');
  });

  it('`replayed` is an optional boolean on the create body', () => {
    const body = create.responses['200'].content['application/json'].schema;
    expect(body.properties.replayed.type).toBe('boolean');
    expect(body.required).not.toContain('replayed');
  });
});

/**
 * #616 Stage 5 — the page-import helpers are part of the wire contract: request keys typed against the fork DTOs, the
 * bounds equal to the DTO constants, the per-item result a closed `oneOf` whose codes are exactly the three the
 * service answers, a candidate that carries ids and indices only (never a title), and the refusals by code.
 */
describe('service-bridge.openapi.json page-import helpers (#616)', () => {
  const S = SPEC as any;
  const refName = (r: any): string => String(r?.$ref ?? '').split('/').pop()!;
  const keysOf = <T,>(m: Record<keyof T, true>): string[] => Object.keys(m).sort();
  const sorted = (o: object): string[] => Object.keys(o).sort();

  it('ValidateContentRequest: the DTO keys, 1..MAX items of { format (the DTO formats), content }', () => {
    const req = S.components.schemas.ValidateContentRequest;
    expect(req.additionalProperties).toBe(false);
    expect(sorted(req.properties)).toEqual(keysOf<ValidateContentDto>({ items: true }));
    expect(req.properties.items).toMatchObject({ minItems: 1, maxItems: PAGE_IMPORT_MAX_ITEMS });
    const item = req.properties.items.items;
    expect(item.additionalProperties).toBe(false);
    expect(sorted(item.properties)).toEqual(keysOf<ValidateContentItemDto>({ format: true, content: true }));
    expect(item.properties.format.enum).toEqual([...PAGE_IMPORT_FORMATS]);
  });

  it('ContentValidationResult: { idx, ok: true } or { idx, ok: false, code ∈ the three codes } — nothing else', () => {
    const [ok, refused] = S.components.schemas.ContentValidationResult.oneOf;
    expect(sorted(ok.properties)).toEqual(['idx', 'ok']);
    expect(ok.properties.ok.const).toBe(true);
    expect(sorted(refused.properties)).toEqual(['code', 'idx', 'ok']);
    expect(refused.properties.ok.const).toBe(false);
    expect([...refused.properties.code.enum].sort()).toEqual(['empty_content', 'invalid_content', 'too_large']);
    for (const branch of [ok, refused]) expect(branch.additionalProperties).toBe(false);
  });

  it('TitleCandidatesRequest: the DTO keys and bounds; only spaceId + titles required', () => {
    const req = S.components.schemas.TitleCandidatesRequest;
    expect(req.additionalProperties).toBe(false);
    expect(sorted(req.properties)).toEqual(keysOf<TitleCandidatesDto>({ spaceId: true, parentPageId: true, titles: true }));
    expect([...req.required].sort()).toEqual(['spaceId', 'titles']);
    expect(req.properties.titles).toMatchObject({ minItems: 1, maxItems: PAGE_IMPORT_MAX_ITEMS });
    expect(req.properties.titles.items).toMatchObject({ minLength: 1, maxLength: PAGE_IMPORT_TITLE_MAX_LENGTH });
  });

  it('TitleCandidate carries exactly { titleIdx, pageId, suffix } — no title', () => {
    const c = S.components.schemas.TitleCandidate;
    expect(sorted(c.properties)).toEqual(keysOf<TitleCandidate>({ titleIdx: true, pageId: true, suffix: true }));
    expect([...c.required].sort()).toEqual(['pageId', 'suffix', 'titleIdx']);
    expect(c.additionalProperties).toBe(false);
  });

  it('declares the refusals by code: validate 503 engine_busy; title-candidates 503 engine_busy | list_too_broad', () => {
    const op = (p: string) => S.paths[p].post;
    expect(refName(op('/api/service/pages/validate-content').responses['503'])).toBe('UnconfiguredOrBusy');
    expect(refName(op('/api/service/pages/title-candidates').responses['503'])).toBe('UnconfiguredBusyOrTooBroad');
    const branches = S.components.responses.UnconfiguredBusyOrTooBroad.content['application/json'].schema.anyOf.map(refName);
    expect(branches.sort()).toEqual(['EngineBusyError', 'Error', 'ListTooBroadError']);
    expect(S.components.schemas.ListTooBroadError.properties.code.const).toBe('list_too_broad');
  });
});
