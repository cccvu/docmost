import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COLLAB_827_RULES,
  COLLAB_EPOCH_STALE_REASON_PREFIX,
  COLLAB_LOAD_TRY_LATER_REASON,
  COLLAB_PAGE_COMPACTING_REASON,
  epochStaleReason,
  pageCompactingRefusal,
  parseEpochStaleReason,
} from './collab-reasons';
import { REFUSED_REASON_PREFIX, TRY_LATER_REASON, UNRESOLVED_REASON } from './update-guard';

/**
 * #827 (ADR 0036): the reasons #827 sends. Their client copies are held equal by the client's parity test
 * (collab-try-later-parity.test.ts), which reads this file's `export const NAME = '…'` lines; this pins what that
 * reading depends on, and the shapes old editors meet.
 */
describe('#827 collab reasons', () => {
  it('the epoch-stale refusal is a refusal to a pre-#827 editor (it starts with the update guard\'s prefix)', () => {
    expect(COLLAB_EPOCH_STALE_REASON_PREFIX.startsWith(REFUSED_REASON_PREFIX)).toBe(true);
    expect(epochStaleReason(3)).toBe('ccc:collab-update-refused:epoch-stale:3');
  });

  it('parses only a well-formed epoch back', () => {
    for (const n of [0, 1, 42, 999_999_999_999_999]) expect(parseEpochStaleReason(epochStaleReason(n))).toBe(n);
    for (const bad of ['ccc:collab-update-refused:epoch-stale:', 'ccc:collab-update-refused:epoch-stale:-1', 'ccc:collab-update-refused:epoch-stale:01', 'ccc:collab-update-refused:epoch-stale:1e3', 'ccc:collab-update-refused:epoch-stale:1 ', 'ccc:collab-update-refused:frame-too-large', TRY_LATER_REASON]) {
      expect(parseEpochStaleReason(bad)).toBeNull();
    }
  });

  it('the try-later reasons are distinct ccc:collab reasons, none of them a refusal or the unresolved reason', () => {
    const reasons = [COLLAB_PAGE_COMPACTING_REASON, COLLAB_LOAD_TRY_LATER_REASON];
    expect(new Set([...reasons, TRY_LATER_REASON, UNRESOLVED_REASON]).size).toBe(4);
    for (const r of reasons) {
      expect(r).toMatch(/^ccc:collab-[a-z-]+$/);
      expect(r.startsWith(REFUSED_REASON_PREFIX)).toBe(false);
    }
  });

  it('a load\'s refusal is { reason } with no message (Hocuspocus logs a message per attempt), fresh and frozen', () => {
    const a = pageCompactingRefusal();
    expect(a).toEqual({ reason: COLLAB_PAGE_COMPACTING_REASON });
    expect('message' in a).toBe(false);
    expect(Object.isFrozen(a)).toBe(true);
    expect(pageCompactingRefusal()).not.toBe(a);
  });

  it('the new rules are fixed words a refusal reason can carry', () => {
    expect([...COLLAB_827_RULES]).toEqual(['frame-too-large', 'apply-deadline', 'page-full']);
    for (const r of COLLAB_827_RULES) expect(REFUSED_REASON_PREFIX + r).toMatch(/^ccc:collab-update-refused:[a-z-]+$/);
  });

  it('every reason is an `export const NAME = \'…\';` line, the form the client parity test reads', () => {
    const src = readFileSync(join(__dirname, 'collab-reasons.ts'), 'utf8');
    for (const [name, value] of Object.entries({ COLLAB_PAGE_COMPACTING_REASON, COLLAB_LOAD_TRY_LATER_REASON, COLLAB_EPOCH_STALE_REASON_PREFIX })) {
      expect(src).toContain(`export const ${name} = '${value}';`);
    }
  });
});
