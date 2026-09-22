import {
  disconnectUserConnections,
  ClosableConnection,
  ConnectedDocument,
} from './disconnect-user-connections';

/**
 * CCC authorization integration test (#455). The enforcement core of the account-disable collab
 * force-disconnect: it MUST close every live socket belonging to the target user across ALL resident
 * documents, and MUST NOT touch any other user's sockets. Flipping the match predicate (e.g. `!==` for
 * `===`, or dropping the id compare) has to red a test — before this spec it red nothing (the controller
 * spec mocks the gateway; the gateway method itself was untested because loading it pulls the lib0 ESM
 * graph, which is exactly why the predicate now lives in this importless helper).
 */

const TARGET = 'target-user';
const OTHER = 'other-user';

/** A fake connection that records whether it was closed, with the same `.context.user.id` shape the real
 *  Hocuspocus connection exposes. */
const conn = (userId: string | undefined) => {
  const c = {
    context: userId === undefined ? {} : { user: { id: userId } },
    closed: false,
    close() {
      c.closed = true;
    },
  };
  return c as ClosableConnection & { closed: boolean };
};

/** A fake resident document exposing a fixed connection set via getConnections(). */
const doc = (...connections: Array<ClosableConnection & { closed: boolean }>): ConnectedDocument & {
  conns: Array<ClosableConnection & { closed: boolean }>;
} => ({
  conns: connections,
  getConnections: () => connections,
});

describe('disconnectUserConnections (#455 collab force-disconnect predicate)', () => {
  it('closes ONLY the target user across ≥2 documents, leaving other users untouched', () => {
    const t1 = conn(TARGET);
    const t2 = conn(TARGET);
    const o1 = conn(OTHER);
    const o2 = conn(OTHER);
    const d1 = doc(t1, o1);
    const d2 = doc(o2, t2); // target present in BOTH documents

    const closed = disconnectUserConnections([d1, d2], TARGET);

    expect(closed).toBe(2);
    expect(t1.closed).toBe(true);
    expect(t2.closed).toBe(true);
    expect(o1.closed).toBe(false);
    expect(o2.closed).toBe(false);
  });

  it('returns 0 and closes nothing when the user has no live connection', () => {
    const o1 = conn(OTHER);
    const closed = disconnectUserConnections([doc(o1)], TARGET);
    expect(closed).toBe(0);
    expect(o1.closed).toBe(false);
  });

  it('ignores connections with no authenticated user (never closes an unmatched/anonymous socket)', () => {
    const anon = conn(undefined);
    const t1 = conn(TARGET);
    const closed = disconnectUserConnections([doc(anon, t1)], TARGET);
    expect(closed).toBe(1);
    expect(anon.closed).toBe(false);
    expect(t1.closed).toBe(true);
  });

  it('handles an empty document set', () => {
    expect(disconnectUserConnections([], TARGET)).toBe(0);
  });
});
