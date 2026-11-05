import { DECIDE_CHUNK, decideAll, humanSubject } from './page-delete-decision';

/**
 * #661 / #618 — `decideAll`, the all-or-nothing bulk decision every remote removal routine (trash, purge) trusts to
 * cover EVERY page it removes. `tryCheckBulk` validates each answer's type, never the answer COUNT, so the length
 * check here is the only thing standing between a short (or padded) PDP answer and a removal of undecided pages.
 */
const SUBJECT = humanSubject({ id: 'user-1' });
const ids = (n: number) => Array.from({ length: n }, (_, i) => `page-${i}`);

const pdp = (answer: (batch: { resourceId: string }[], call: number) => boolean[] | null) => {
  const batches: string[][] = [];
  return {
    batches,
    authz: {
      tryCheckBulk: jest.fn(async (_s: unknown, checks: { permission: string; resourceType: string; resourceId: string }[]) => {
        batches.push(checks.map((c) => c.resourceId));
        return answer(checks, batches.length - 1);
      }),
    },
  };
};

describe('decideAll — allowed only when every page got exactly one affirmative answer', () => {
  it('every answer true → allowed; asks (permission, resourceType) about each id once', async () => {
    const t = pdp((b) => b.map(() => true));
    expect(await decideAll(t.authz, SUBJECT, 'edit', 'page', ids(3))).toBe('allowed');
    expect(t.authz.tryCheckBulk).toHaveBeenCalledWith(SUBJECT, [
      { permission: 'edit', resourceType: 'page', resourceId: 'page-0' },
      { permission: 'edit', resourceType: 'page', resourceId: 'page-1' },
      { permission: 'edit', resourceType: 'page', resourceId: 'page-2' },
    ]);
  });

  it('a SHORT answer (fewer results than pages, all true) → denied, never allowed', async () => {
    const t = pdp(() => [true]);
    expect(await decideAll(t.authz, SUBJECT, 'edit', 'page', ids(3))).toBe('denied');
  });

  it('a LONG answer (more results than pages, all true) → denied', async () => {
    const t = pdp((b) => [...b.map(() => true), true]);
    expect(await decideAll(t.authz, SUBJECT, 'edit', 'page', ids(3))).toBe('denied');
  });

  it('an empty answer for a non-empty set → denied', async () => {
    const t = pdp(() => []);
    expect(await decideAll(t.authz, SUBJECT, 'edit', 'page', ids(2))).toBe('denied');
  });

  it('one false → denied', async () => {
    const t = pdp((b) => b.map((_, i) => i !== 1));
    expect(await decideAll(t.authz, SUBJECT, 'edit', 'page', ids(3))).toBe('denied');
  });

  it('a failed or malformed call (null) → unavailable, never denied and never allowed', async () => {
    const t = pdp(() => null);
    expect(await decideAll(t.authz, SUBJECT, 'edit', 'page', ids(3))).toBe('unavailable');
  });

  it('an empty set → allowed with no PDP call (nothing to remove)', async () => {
    const t = pdp(() => null);
    expect(await decideAll(t.authz, SUBJECT, 'edit', 'page', [])).toBe('allowed');
    expect(t.authz.tryCheckBulk).not.toHaveBeenCalled();
  });
});

describe(`decideAll — chunks of ${DECIDE_CHUNK} (the platform's @ArrayMaxSize)`, () => {
  const N = DECIDE_CHUNK * 2 + 1;

  it('asks every id exactly once, in chunks no larger than the cap → allowed', async () => {
    const t = pdp((b) => b.map(() => true));
    expect(await decideAll(t.authz, SUBJECT, 'edit', 'page', ids(N))).toBe('allowed');
    expect(t.batches.map((b) => b.length)).toEqual([DECIDE_CHUNK, DECIDE_CHUNK, 1]);
    expect(t.batches.flat()).toEqual(ids(N));
  });

  it('a short answer in a LATER chunk → denied (every chunk is length-checked)', async () => {
    const t = pdp((b, call) => (call === 1 ? b.slice(1).map(() => true) : b.map(() => true)));
    expect(await decideAll(t.authz, SUBJECT, 'edit', 'page', ids(N))).toBe('denied');
  });

  it('stops at the first chunk that is not allowed (denied or unavailable)', async () => {
    const denied = pdp((b, call) => b.map(() => call !== 0));
    expect(await decideAll(denied.authz, SUBJECT, 'edit', 'page', ids(N))).toBe('denied');
    expect(denied.batches).toHaveLength(1);

    const failed = pdp((b, call) => (call === 1 ? null : b.map(() => true)));
    expect(await decideAll(failed.authz, SUBJECT, 'edit', 'page', ids(N))).toBe('unavailable');
    expect(failed.batches).toHaveLength(2);
  });
});
