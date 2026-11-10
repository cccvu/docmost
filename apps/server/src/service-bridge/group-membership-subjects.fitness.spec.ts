import { readFileSync } from 'fs';
import { join } from 'path';
import { sourceFiles } from '../authz/route-guard/ast-sink-scan';
import { mapOutboxRow } from './authz-change-event';

/**
 * wiki-v2 #797 FITNESS — group membership carries USERS only, so the projection can never emit a subject relation on
 * `group#member` (no nested groups: a group in a group would make every grant to the outer group reach the inner
 * group's members invisibly, and the reconciler models `group#member@user` only).
 *  - the feed's `GroupMemberChanged` names exactly one user and one group (no subject type, no subject relation);
 *  - every CCC write of `group_users` (service bridge, authz) is the group control plane's own insert/delete, and its
 *    insert names `user_id` resolved from integrator externalIds (the column references `users`).
 * Upstream's native group routes are refused in remote mode (`groupAdmin` family) and also insert users only.
 */
const SRC_ROOT = join(__dirname, '..'); // .../apps/server/src
const GROUP_USERS_WRITE_RE = /\b(?:insert\s+into|update|delete\s+from)\s+"?group_users"?\b/gi;

describe('group membership subjects are users only (#797)', () => {
  it('GroupMemberChanged carries exactly a group id and a user id', () => {
    const e = mapOutboxRow({ id: 7, op: 'INSERT', tableName: 'group_users', payload: { group_id: 'g1', user_id: 'u1', role: 'x' } });
    expect(e).toEqual({ seq: 7, type: 'GroupMemberChanged', groupId: 'g1', userId: 'u1', removed: false });
    expect(Object.keys(e!).sort()).toEqual(['groupId', 'removed', 'seq', 'type', 'userId']);
    // A row with no user (never a group-in-group) maps to nothing rather than to a group subject.
    expect(mapOutboxRow({ id: 8, op: 'INSERT', tableName: 'group_users', payload: { group_id: 'g1', member_group_id: 'g2' } })).toBeNull();
  });

  it('every CCC group_users write is in the group control plane, and its insert names user_id only', () => {
    const hits: string[] = [];
    for (const root of ['service-bridge', 'authz']) {
      for (const file of sourceFiles(join(SRC_ROOT, root))) {
        if (/\.(spec|testkit)\.ts$/.test(file)) continue;
        const src = readFileSync(file, 'utf8');
        for (const m of src.matchAll(GROUP_USERS_WRITE_RE)) {
          hits.push(`${file.slice(SRC_ROOT.length + 1)}:${m[0].toLowerCase().replace(/\s+/g, ' ')}`);
        }
      }
    }
    expect(hits.sort()).toEqual([
      'service-bridge/service-group.service.ts:delete from group_users',
      'service-bridge/service-group.service.ts:insert into group_users',
    ]);
    const src = readFileSync(join(SRC_ROOT, 'service-bridge/service-group.service.ts'), 'utf8');
    expect(src).toMatch(/insert into group_users \(user_id, group_id\)/);
  });
});
