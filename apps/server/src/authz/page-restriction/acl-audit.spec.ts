import {
  ACL_AUDIT_EVENT,
  ACL_AUDIT_LIST_CAP,
  AclAuditAction,
  aclAuditPayload,
  aclRefusalAuditPayload,
} from './acl-audit';
import { AuditEvent } from '../../common/events/audit-events';
import { AclEffect, AclGrant } from './acl-state';
import { MAX_PAGE_GRANTEES } from './dto';

/**
 * #503: the domain-audit row of an applied page-ACL write — upstream event names, ids and roles only, every list
 * bounded, and `metadata.surface: 'engine'` so it is never read as the authoritative `/v1` agent attribution.
 */
const PAGE = { id: '11111111-1111-4111-8111-111111111111', spaceId: '22222222-2222-4222-8222-222222222222' };
const U1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const G1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const effect = (e: Partial<AclEffect>): AclEffect => ({
  restrictedBefore: true,
  restrictedAfter: true,
  added: [],
  changed: [],
  removed: [],
  ...e,
});
const userGrant = (id: string, role = 'reader'): AclGrant => ({ userId: id, groupId: null, role });

describe('aclAuditPayload (#503)', () => {
  it.each<[AclAuditAction, string, string]>([
    ['restrict', 'page.restricted', 'restricted'],
    ['unrestrict', 'page.restriction_removed', 'unrestricted'],
    ['add', 'page.permission_added', 'granted'],
    ['update', 'page.permission_added', 'role_changed'],
    ['remove', 'page.permission_removed', 'revoked'],
  ])('%s → %s (operation %s), on the page and its space, marked surface engine', (action, event, operation) => {
    expect(ACL_AUDIT_EVENT[action]).toEqual({ event, operation });
    const p = aclAuditPayload(action, PAGE, effect({}));
    expect(p).toMatchObject({
      event,
      resourceType: 'page',
      resourceId: PAGE.id,
      spaceId: PAGE.spaceId,
      metadata: { surface: 'engine', operation },
    });
  });

  it('restrict carries the restricted flip, the actor self-grant and the retained role', () => {
    const p = aclAuditPayload(
      'restrict',
      PAGE,
      effect({ restrictedBefore: false, added: [userGrant(U1, 'writer')], retainedRole: 'writer' }),
    );
    expect(p.changes).toEqual({ before: { restricted: false }, after: { restricted: true } });
    expect(p.metadata).toEqual({
      surface: 'engine',
      operation: 'restricted',
      added: [{ userId: U1, role: 'writer' }],
      changed: [],
      removed: [],
      retainedRole: 'writer',
    });
  });

  it('keeps retainedRole: null (the actor kept nothing), and omits it for a write that is not a restrict', () => {
    expect(aclAuditPayload('restrict', PAGE, effect({ restrictedBefore: false, retainedRole: null })).metadata).toHaveProperty(
      'retainedRole',
      null,
    );
    expect(aclAuditPayload('add', PAGE, effect({ added: [userGrant(U1)] })).metadata).not.toHaveProperty('retainedRole');
  });

  it('unrestrict lists the cascaded grants; past the cap it truncates and records the full count', () => {
    const small = aclAuditPayload('unrestrict', PAGE, effect({ restrictedAfter: false, removed: [userGrant(U1)] }));
    expect(small.metadata).toMatchObject({ removed: [{ userId: U1, role: 'reader' }] });
    expect(small.metadata).not.toHaveProperty('truncated');

    expect(ACL_AUDIT_LIST_CAP).toBe(MAX_PAGE_GRANTEES);
    const many = Array.from({ length: ACL_AUDIT_LIST_CAP + 7 }, (_, i) =>
      userGrant(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`),
    );
    const big = aclAuditPayload('unrestrict', PAGE, effect({ restrictedAfter: false, removed: many }));
    expect(big.metadata!.removed).toHaveLength(ACL_AUDIT_LIST_CAP);
    expect(big.metadata!.removed[0]).toEqual({ userId: many[0].userId, role: 'reader' });
    expect(big.metadata!.truncated).toEqual({ removed: ACL_AUDIT_LIST_CAP + 7 });
  });

  it('a list of exactly the cap is not truncated', () => {
    const exact = Array.from({ length: ACL_AUDIT_LIST_CAP }, (_, i) => userGrant(String(i)));
    const p = aclAuditPayload('remove', PAGE, effect({ removed: exact }));
    expect(p.metadata!.removed).toHaveLength(ACL_AUDIT_LIST_CAP);
    expect(p.metadata).not.toHaveProperty('truncated');
  });

  it('update carries its one change as fromRole → toRole', () => {
    const p = aclAuditPayload(
      'update',
      PAGE,
      effect({ changed: [{ userId: U1, groupId: null, fromRole: 'reader', toRole: 'writer' }] }),
    );
    expect(p.metadata).toMatchObject({ added: [], removed: [], changed: [{ userId: U1, fromRole: 'reader', toRole: 'writer' }] });
  });

  it('an add that both grants and re-roles lists both; a group entry carries groupId and no userId', () => {
    const p = aclAuditPayload(
      'add',
      PAGE,
      effect({
        added: [{ userId: null, groupId: G1, role: 'writer' }],
        changed: [{ userId: U1, groupId: null, fromRole: 'reader', toRole: 'writer' }],
      }),
    );
    expect(p.metadata!.added).toEqual([{ groupId: G1, role: 'writer' }]);
    expect(p.metadata!.changed).toEqual([{ userId: U1, fromRole: 'reader', toRole: 'writer' }]);
  });

  it('never carries the page title (or any other page field), even when the page object has one', () => {
    const TITLE = 'Confidential merger plan zq9';
    const page = { ...PAGE, title: TITLE, slugId: 'slug-zq9', workspaceId: 'ws-zq9' } as never;
    for (const action of Object.keys(ACL_AUDIT_EVENT) as AclAuditAction[]) {
      const json = JSON.stringify(
        aclAuditPayload(action, page, effect({ added: [userGrant(U1)], removed: [userGrant(G1)], retainedRole: 'reader' })),
      );
      expect(json).not.toContain('zq9');
      expect(json).not.toContain('title');
    }
  });
});

describe('aclRefusalAuditPayload (#673)', () => {
  it.each<[AclAuditAction, string]>([
    ['add', 'self_grant'],
    ['update', 'self_grant'],
    ['unrestrict', 'actor_cannot_edit'],
  ])('%s refused %s → one page.acl_write_refused row: ids, the action and the reason, nothing else', (action, reason) => {
    expect(aclRefusalAuditPayload(action, PAGE, reason)).toEqual({
      event: 'page.acl_write_refused',
      resourceType: 'page',
      resourceId: PAGE.id,
      spaceId: PAGE.spaceId,
      metadata: { surface: 'engine', outcome: 'denied', action, reason },
    });
  });

  it.each(['exposes_subpages', 'not_restricted', 'precondition_failed', 'grant_not_found', 'engine_busy', ''])(
    'a state refusal (%p) is not audited: undefined',
    (reason) => {
      expect(aclRefusalAuditPayload('unrestrict', PAGE, reason)).toBeUndefined();
    },
  );

  it('is not an upstream event name (no upstream event is reused for a denial)', () => {
    expect(Object.values(AuditEvent)).not.toContain('page.acl_write_refused');
  });

  it('never carries the page title (or any other page field)', () => {
    const page = { ...PAGE, title: 'Confidential merger plan zq9', slugId: 'slug-zq9', workspaceId: 'ws-zq9' } as never;
    const json = JSON.stringify(aclRefusalAuditPayload('unrestrict', page, 'actor_cannot_edit'));
    expect(json).not.toContain('zq9');
    expect(json).not.toContain('title');
  });
});
