import * as Y from 'yjs';
import { Hocuspocus } from '@hocuspocus/server';
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap';
import { serverSchema } from '../page-write/prelim-content';
import { authFrame, awarenessFrame, contentOf, DOC_NAME, FakeSocket, RemoteClient, renderLikeABrowser, SYNC, syncFrame } from './collab-ingress.testkit';
import { CollabUpdateGuardExtension } from './collab-update-guard.extension';
import { AWARENESS_BINDS_PER_USER, AWARENESS_NEW_IDS_REFILL_MS, COLLAB_REFUSAL_CODE, CollabUpdateGuard, UNRESOLVED_REASON } from './update-guard';

/**
 * #781 lineage (ADR 0036 §4): a client id is bound to a user by that user's own awareness, or by its first struct only
 * when the sender's connection announced that id (or announced nothing: the rule before this evidence). A lifetime that
 * lost a co-editor's structs (a crash inside the store debounce) gets them back from whichever peer resends them first:
 * the server's relay to that peer made them part of its Step2 or IndexedDB echo. Binding them to that peer refused the
 * real author `foreign-client` for the rest of the lifetime. And the mirror ordering (the author's awareness lands first,
 * then the peer's relay) is answered `unresolved`, never applied: the peer reconnects once and by then the author's own
 * Step2 has made those clocks known. That holds for a ONE-SIDED relay, and only when the author's Step2 lands before the
 * peer's retry; both limits are pinned as residuals below (and the crash corpus in honest-concurrency.spec.ts measures
 * them).
 *
 * Driven like update-guard.spec.ts: `deliver` stands in for Hocuspocus (the guard first, then the apply), and `meta` for
 * the awareness clocks Hocuspocus's Document keeps. One describe runs the orderings through a real Hocuspocus 4.7.1.
 */
const REFUSED = (rule: string) => `ccc:collab-update-refused:${rule}`;
const SEED = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'base' }] }] };
/** The co-editor whose structs the new lifetime lost (B), the peer that holds them (A), a third writer (M). */
const B_ID = 1001;
const A_ID = 2002;
const B_NEW_TAB = 3003;

type Conn = { readOnly: boolean; webSocket: { close: jest.Mock }; context: { user: { id: string } } };
const textOf = (el: Y.XmlElement): Y.XmlText => el.toArray().find((c) => c instanceof Y.XmlText) as Y.XmlText;
const typeAt0 = (c: RemoteClient, against: Y.Doc, text: string) => c.edit(against, (f) => textOf(f.get(0) as Y.XmlElement).insert(0, text));
const clientsOf = (update: Uint8Array) => new Set(Y.decodeUpdate(update).structs.map((s) => s.id.client));

/** A live document loaded from `stored` (the row the new lifetime read), under a fresh guard, with an awareness meta. */
function lifetime(stored: Uint8Array, opts: { now?: () => number } = {}) {
  const live = new Y.Doc() as Y.Doc & { name: string; awareness: { meta: Map<number, { clock: number }> } };
  live.name = DOC_NAME;
  Y.applyUpdate(live, stored);
  live.awareness = { meta: new Map() };
  const logs: string[] = [];
  const guard = new CollabUpdateGuard({ mode: 'enforce', logger: { warn: (m: string) => logs.push(m) }, now: opts.now });
  const conn = (id: string): Conn => ({ readOnly: false, webSocket: { close: jest.fn() }, context: { user: { id } } });
  const deliver = (c: Conn, frame: Uint8Array, apply?: Uint8Array): string => {
    try {
      expect(guard.check({ connection: c, document: live, update: frame, context: c.context })).toBeUndefined();
    } catch (err: any) {
      expect(err).toEqual({ code: COLLAB_REFUSAL_CODE, reason: expect.any(String) });
      return err.reason;
    }
    if (apply) Y.applyUpdate(live, apply, c);
    return 'applied';
  };
  /** An awareness state for each id; on success the meta advances as y-protocols' applyAwarenessUpdate does. */
  const announce = (c: Conn, ...entries: Array<{ clientID: number; clock?: number; state?: unknown }>): string => {
    const full = entries.map((e) => ({ clientID: e.clientID, clock: e.clock ?? 1, state: e.state === undefined ? { user: { name: c.context.user.id } } : e.state }));
    const out = deliver(c, awarenessFrame(full));
    if (out === 'applied') {
      for (const e of full) if ((live.awareness.meta.get(e.clientID)?.clock ?? -1) < e.clock) live.awareness.meta.set(e.clientID, { clock: e.clock });
    }
    return out;
  };
  const send = (c: Conn, update: Uint8Array, subtype: number = SYNC.Update) => deliver(c, syncFrame(update, subtype), update);
  /** The bytes a client sends as its Step2 (or a y-indexeddb remount echo): everything live lacks. */
  const step2 = (doc: Y.Doc) => Y.encodeStateAsUpdate(doc, Y.encodeStateVector(live));
  return { live, guard, logs, conn, deliver, announce, send, step2 };
}

/**
 * Lifetime 1: B typed `stored` text (saved) when `storedPrefix`, then `B-lost ` (relayed to A, never stored); then the
 * process died. B keeps typing `B-after ` while disconnected. `stored` is the row the next lifetime loads.
 */
function lostLifetime(opts: { storedPrefix: boolean }) {
  const base = Y.encodeStateAsUpdate(prosemirrorJSONToYDoc(serverSchema(), SEED, 'default'));
  const life1 = new Y.Doc();
  Y.applyUpdate(life1, base);
  const b = new RemoteClient(life1, B_ID);
  if (opts.storedPrefix) Y.applyUpdate(life1, typeAt0(b, life1, 'B-stored '));
  const stored = Y.encodeStateAsUpdate(life1);
  Y.applyUpdate(life1, typeAt0(b, life1, 'B-lost '));
  const a = new RemoteClient(life1, A_ID); // A loaded the page and was relayed B's edit
  b.doc.transact(() => textOf(b.fragment.get(0) as Y.XmlElement).insert(0, 'B-after ')); // unsent: the socket is down
  return { stored, a, b };
}

/** A third writer impersonating B's id at its next clock. */
const forgeAtB = (live: Y.Doc) => typeAt0(new RemoteClient(live, B_ID), live, 'FORGED ');

describe('the mirror race: B announces its id before A relays B\'s lost structs', () => {
  it.each([
    ['a stored id (B saved a prefix: the common case)', true],
    ['a never-seen id (all of B\'s edits were lost)', false],
  ])('%s: A gets unresolved (never applied), B\'s Step2 lands, A\'s replay on a fresh connection is applied', (_name, storedPrefix) => {
    const { stored, a, b } = lostLifetime({ storedPrefix });
    const s = lifetime(stored);
    // preconditions: the carrier really holds B's clocks past the stored state, and the stored state holds B or not
    expect(Y.getState(s.live.store, B_ID) > 0).toBe(storedPrefix);
    const relay = s.step2(a.doc);
    expect(clientsOf(relay)).toEqual(new Set([B_ID]));

    const bConn = s.conn('B');
    const aConn = s.conn('A');
    expect(s.announce(bConn, { clientID: B_ID })).toBe('applied');
    expect(s.announce(aConn, { clientID: A_ID })).toBe('applied');
    const before = Y.encodeStateAsUpdate(s.live);
    expect(s.send(aConn, relay, SYNC.Step2)).toBe(UNRESOLVED_REASON);
    expect(Buffer.from(Y.encodeStateAsUpdate(s.live)).equals(Buffer.from(before))).toBe(true); // never applied
    // logged as the foreign-client it is, at a fixed stage word (attacks stay visible)
    const line = s.logs.find((l) => l.startsWith('COLLAB_UPDATE_REFUSED'))!;
    expect(JSON.parse(line.slice(line.indexOf('{')))).toMatchObject({ rule: 'foreign-client', stage: 'unproven-owner', userId: 'A' });

    expect(s.send(bConn, s.step2(b.doc), SYNC.Step2)).toBe('applied');
    // A's provider reconnects once (collab-access.ts): a new connection, its own awareness, the same Step2 bytes
    const aConn2 = s.conn('A');
    expect(s.announce(aConn2, { clientID: A_ID, clock: 2 })).toBe('applied');
    expect(s.send(aConn2, relay, SYNC.Step2)).toBe('applied');
    expect(renderLikeABrowser(s.live).text).toBe(`B-after B-lost ${storedPrefix ? 'B-stored ' : ''}base`);
    // B has now written at its id in this lifetime: a third writer's forgery is the plain refusal again
    expect(s.send(s.conn('M'), forgeAtB(s.live))).toBe(REFUSED('foreign-client'));
  });

  it('an id bound by awareness whose owner never writes: a forgery stays unapplied on every retry', () => {
    const { stored } = lostLifetime({ storedPrefix: true });
    const s = lifetime(stored);
    expect(s.announce(s.conn('B'), { clientID: B_ID })).toBe('applied');
    const before = Y.encodeStateAsUpdate(s.live);
    for (let i = 0; i < 3; i++) expect(s.send(s.conn('M'), forgeAtB(s.live))).toBe(UNRESOLVED_REASON);
    expect(Buffer.from(Y.encodeStateAsUpdate(s.live)).equals(Buffer.from(before))).toBe(true);
    expect(renderLikeABrowser(s.live).text).not.toContain('FORGED');
  });
});

describe('a relay of a co-editor\'s lost structs leaves the id unbound', () => {
  it('A relays first; B reconnects with the same id, claims it by awareness and keeps editing; then a forgery is refused', () => {
    const { stored, a, b } = lostLifetime({ storedPrefix: false });
    const s = lifetime(stored);
    const aConn = s.conn('A');
    expect(s.announce(aConn, { clientID: A_ID })).toBe('applied');
    expect(s.send(aConn, s.step2(a.doc), SYNC.Step2)).toBe('applied');
    const bConn = s.conn('B');
    expect(s.announce(bConn, { clientID: B_ID })).toBe('applied');
    expect(s.send(bConn, s.step2(b.doc), SYNC.Step2)).toBe('applied');
    expect(s.send(bConn, typeAt0(b, s.live, 'B-more '))).toBe('applied');
    expect(renderLikeABrowser(s.live).text).toBe('B-more B-after B-lost base');
    expect(s.send(s.conn('M'), forgeAtB(s.live))).toBe(REFUSED('foreign-client'));
  });

  it('A relays first; B\'s replaced tab (a new id) echoes B\'s unsent tail from IndexedDB: applied, nothing lost', () => {
    const { stored, a, b } = lostLifetime({ storedPrefix: false });
    const s = lifetime(stored);
    const aConn = s.conn('A');
    expect(s.announce(aConn, { clientID: A_ID })).toBe('applied');
    expect(s.send(aConn, s.step2(a.doc), SYNC.Step2)).toBe('applied');
    // B reloaded during the outage: a new tab, a new client id, the old session's structs replayed from IndexedDB
    const tab = new RemoteClient(b.doc, B_NEW_TAB);
    const echo = s.step2(tab.doc);
    expect(clientsOf(echo)).toEqual(new Set([B_ID])); // precondition: only the old id's unsent tail
    const tabConn = s.conn('B');
    expect(s.announce(tabConn, { clientID: B_NEW_TAB })).toBe('applied');
    expect(s.send(tabConn, echo, SYNC.Step2)).toBe('applied');
    expect(renderLikeABrowser(s.live).text).toBe('B-after B-lost base');
    expect(s.send(tabConn, typeAt0(tab, s.live, 'tab '))).toBe('applied');
  });

  it('a reconnect resending its own bound id (an echo at the held clock) still counts as announcing it', () => {
    const { stored, a, b } = lostLifetime({ storedPrefix: false });
    const s = lifetime(stored);
    expect(s.announce(s.conn('A'), { clientID: A_ID })).toBe('applied'); // A's first connection binds A's id
    const aConn2 = s.conn('A');
    expect(s.announce(aConn2, { clientID: A_ID })).toBe('applied'); // same clock: an echo of A's own state
    expect(s.send(aConn2, s.step2(a.doc), SYNC.Step2)).toBe('applied');
    const bConn = s.conn('B');
    expect(s.announce(bConn, { clientID: B_ID })).toBe('applied');
    expect(s.send(bConn, s.step2(b.doc), SYNC.Step2)).toBe('applied');
  });

  it('a mixed relay: the sender\'s own announced id binds to it, the co-editor\'s stays unbound', () => {
    const { stored, a, b } = lostLifetime({ storedPrefix: false });
    const s = lifetime(stored);
    typeAt0(a, s.live, 'A-own '); // A's own unsent edit, never seen by this lifetime
    const relay = s.step2(a.doc);
    expect(clientsOf(relay)).toEqual(new Set([A_ID, B_ID]));
    const aConn = s.conn('A');
    expect(s.announce(aConn, { clientID: A_ID })).toBe('applied');
    expect(s.send(aConn, relay, SYNC.Step2)).toBe('applied');
    expect(s.send(s.conn('M'), typeAt0(new RemoteClient(s.live, A_ID), s.live, 'FORGED '))).toBe(REFUSED('foreign-client'));
    const bConn = s.conn('B');
    expect(s.announce(bConn, { clientID: B_ID })).toBe('applied');
    expect(s.send(bConn, s.step2(b.doc), SYNC.Step2)).toBe('applied');
  });

  it(`announcements count past the ${AWARENESS_BINDS_PER_USER}-per-user bind budget: the own id binds by struct, a relayed one stays unbound`, () => {
    let t = 1_000_000;
    const { stored, b } = lostLifetime({ storedPrefix: false });
    const s = lifetime(stored, { now: () => t });
    let next = 10_000;
    for (let n = 0; n < AWARENESS_BINDS_PER_USER / 32; n++) {
      const entries = Array.from({ length: 32 }, () => ({ clientID: next++ }));
      expect(s.announce(s.conn('hog'), ...entries)).toBe('applied');
      t += 32 * AWARENESS_NEW_IDS_REFILL_MS;
    }
    const bound = s.guard.bindingCount(s.live);
    const hog = s.conn('hog');
    const own = new RemoteClient(s.live, 77_777);
    expect(s.announce(hog, { clientID: 77_777 })).toBe('applied');
    expect(s.guard.bindingCount(s.live)).toBe(bound); // past the budget: announced, not bound
    expect(s.send(hog, typeAt0(own, s.live, 'hog '))).toBe('applied'); // its first struct binds it (own evidence)
    expect(s.send(s.conn('M'), typeAt0(new RemoteClient(s.live, 77_777), s.live, 'FORGED '))).toBe(REFUSED('foreign-client'));
    // the same connection relaying B's lost structs does not take B's id
    const relayer = new RemoteClient(s.live, A_ID);
    Y.applyUpdate(relayer.doc, Y.encodeStateAsUpdate(b.doc));
    expect(s.send(hog, s.step2(relayer.doc), SYNC.Step2)).toBe('applied');
    expect(s.announce(s.conn('B'), { clientID: B_ID })).toBe('applied');
  });
});

describe('residuals pinned (ADR 0036 §4): equal to the rule before this evidence, not closed', () => {
  it('a relayer that sends no awareness still gets the old rule: it binds the co-editor\'s lost id, and B is refused', () => {
    const { stored, a } = lostLifetime({ storedPrefix: false });
    const s = lifetime(stored);
    const silent = s.conn('A'); // announces nothing: a pagehide-nulled awareness looks the same, and so does an attacker
    expect(s.send(silent, s.step2(a.doc), SYNC.Step2)).toBe('applied');
    expect(s.announce(s.conn('B'), { clientID: B_ID })).toBe(REFUSED('foreign-client'));
  });

  it('a null awareness is no announcement: the first struct at a never-seen id binds it to the sender', () => {
    const { stored, a } = lostLifetime({ storedPrefix: false });
    const s = lifetime(stored);
    const aConn = s.conn('A');
    expect(s.announce(aConn, { clientID: A_ID, state: null })).toBe('applied');
    expect(s.send(aConn, s.step2(a.doc), SYNC.Step2)).toBe('applied');
    expect(s.announce(s.conn('B'), { clientID: B_ID })).toBe(REFUSED('foreign-client'));
  });
});

/**
 * Lifetime 1 where BOTH co-editors typed inside the store debounce and each was relayed the other's edit before the
 * crash: A's Step2 carries A's lost tail and B's, B's carries B's and A's.
 */
function bothLostLifetime(opts: { storedPrefix: boolean }) {
  const life1 = new Y.Doc();
  Y.applyUpdate(life1, Y.encodeStateAsUpdate(prosemirrorJSONToYDoc(serverSchema(), SEED, 'default')));
  const b = new RemoteClient(life1, B_ID);
  const a = new RemoteClient(life1, A_ID);
  if (opts.storedPrefix) {
    Y.applyUpdate(life1, typeAt0(b, life1, 'B-stored '));
    a.sync(life1);
    Y.applyUpdate(life1, typeAt0(a, life1, 'A-stored '));
    b.sync(life1);
  }
  const stored = Y.encodeStateAsUpdate(life1);
  Y.applyUpdate(life1, typeAt0(b, life1, 'B-lost '));
  a.sync(life1);
  Y.applyUpdate(life1, typeAt0(a, life1, 'A-lost '));
  b.sync(life1);
  return { stored, a, b };
}

describe('pinned residuals of the mirror-race answer (ADR 0036 §4): one-sided relays only, and a timing assumption', () => {
  it.each([
    ['a stored id', true],
    ['a never-seen id', false],
  ])('%s, BOTH co-editors lost a tail: each Step2 hits the other\'s unproven id, both are unresolved twice (final), live never changes', (_name, storedPrefix) => {
    // Not a regression (the rule before this change refused both foreign-client at once), and not fixed: neither frame
    // can land, so neither id is ever proven, and a reload within the lifetime replays the same ids. The deadlock ends
    // with the lifetime (the document unloads once no editor holds it; a new lifetime binds nothing).
    const { stored, a, b } = bothLostLifetime({ storedPrefix });
    const s = lifetime(stored);
    expect(Y.getState(s.live.store, B_ID) > 0).toBe(storedPrefix);
    expect(clientsOf(s.step2(a.doc))).toEqual(new Set([A_ID, B_ID])); // precondition: each carries both lost tails
    expect(clientsOf(s.step2(b.doc))).toEqual(new Set([A_ID, B_ID]));
    const before = Y.encodeStateAsUpdate(s.live);
    for (let attempt = 1; attempt <= 2; attempt++) {
      // a reconnect: new connections, each announcing its own id again (an echo of its own bound id), then its Step2
      const bConn = s.conn('B');
      const aConn = s.conn('A');
      expect(s.announce(bConn, { clientID: B_ID, clock: attempt })).toBe('applied');
      expect(s.announce(aConn, { clientID: A_ID, clock: attempt })).toBe('applied');
      expect(s.send(aConn, s.step2(a.doc), SYNC.Step2)).toBe(UNRESOLVED_REASON);
      expect(s.send(bConn, s.step2(b.doc), SYNC.Step2)).toBe(UNRESOLVED_REASON);
    }
    // the client's second `unresolved` before sync-acked is final (collab-access.ts): both editors are refused
    expect(Buffer.from(Y.encodeStateAsUpdate(s.live)).equals(Buffer.from(before))).toBe(true);
    const stages = s.logs.filter((l) => l.startsWith('COLLAB_UPDATE_REFUSED')).map((l) => JSON.parse(l.slice(l.indexOf('{'))));
    expect(stages).toHaveLength(4);
    for (const line of stages) expect(line).toMatchObject({ rule: 'foreign-client', stage: 'unproven-owner' });
  });

  it('timing: A\'s one retry lands before B\'s Step2 (B\'s round trip over twice A\'s): A is unresolved again, which is final', () => {
    // The one-sided recovery assumes the author's Step2 reaches the server before the relayer has reconnected (its
    // close, a new Auth and Step1, then its Step2: about two of its round trips after the refusal).
    const { stored, a, b } = lostLifetime({ storedPrefix: true });
    const s = lifetime(stored);
    const bConn = s.conn('B');
    expect(s.announce(bConn, { clientID: B_ID })).toBe('applied');
    expect(s.announce(s.conn('A'), { clientID: A_ID })).toBe('applied');
    expect(s.send(s.conn('A'), s.step2(a.doc), SYNC.Step2)).toBe(UNRESOLVED_REASON);
    const aRetry = s.conn('A');
    expect(s.announce(aRetry, { clientID: A_ID, clock: 2 })).toBe('applied');
    expect(s.send(aRetry, s.step2(a.doc), SYNC.Step2)).toBe(UNRESOLVED_REASON); // the client stops here
    expect(s.send(bConn, s.step2(b.doc), SYNC.Step2)).toBe('applied'); // B's own edits are not lost
    expect(renderLikeABrowser(s.live).text).toBe('B-after B-lost B-stored base');
  });
});

describe('an owner is proven only by a frame that is ACCEPTED', () => {
  it.each([
    [
      'a missing dependency (answered unresolved)',
      (s: ReturnType<typeof lifetime>, b: RemoteClient) => {
        const other = new RemoteClient(s.live, 5555);
        typeAt0(other, s.live, 'x');
        const sv = Y.encodeStateVector(other.doc);
        typeAt0(other, s.live, 'y');
        return Y.mergeUpdates([s.step2(b.doc), Y.encodeStateAsUpdate(other.doc, sv)]); // 5555's clock 1 without clock 0
      },
      UNRESOLVED_REASON,
    ],
    [
      'a content violation at the owner\'s own id that only the shadow sees (refused)',
      (s: ReturnType<typeof lifetime>, b: RemoteClient) => {
        // a listItem whose first child is a list: every struct is valid alone (the stateless pre-pass passes it), the
        // element is not, so the refusal comes after the owner's structs were inspected
        b.doc.transact(() => {
          const el = (name: string, ...children: Array<Y.XmlElement | Y.XmlText>) => {
            const e = new Y.XmlElement(name);
            e.insert(0, children);
            return e;
          };
          b.fragment.insert(b.fragment.length, [el('bulletList', el('listItem', el('bulletList', el('listItem', el('paragraph', new Y.XmlText('x'))))))]);
        });
        return s.step2(b.doc);
      },
      REFUSED('schema'),
    ],
  ])('B\'s frame with new clocks at its awareness-only id is refused for %s: A\'s relay is still unresolved', (_name, frameOf, answer) => {
    const { stored, a, b } = lostLifetime({ storedPrefix: true });
    const s = lifetime(stored);
    const bConn = s.conn('B');
    expect(s.announce(bConn, { clientID: B_ID })).toBe('applied');
    const bad = frameOf(s, b);
    expect(clientsOf(bad).has(B_ID)).toBe(true); // precondition: B writes new clocks at its own id
    expect(s.send(bConn, bad, SYNC.Step2)).toBe(answer);
    const aConn = s.conn('A');
    expect(s.announce(aConn, { clientID: A_ID })).toBe('applied');
    expect(s.send(aConn, s.step2(a.doc), SYNC.Step2)).toBe(UNRESOLVED_REASON); // B is still unproven: not foreign-client
  });
});

describe('the per-connection announcement evidence is bounded', () => {
  it('an id announced past the per-connection cap is not the connection\'s own: its struct at a never-seen id stays unbound', () => {
    let t = 1_000_000;
    const s = lifetime(Y.encodeStateAsUpdate(prosemirrorJSONToYDoc(serverSchema(), SEED, 'default')), { now: () => t });
    const hog = s.conn('hog');
    expect(s.announce(hog, ...Array.from({ length: 32 }, (_, i) => ({ clientID: 10_000 + i })))).toBe('applied');
    t += 32 * AWARENESS_NEW_IDS_REFILL_MS;
    // control: an id inside the cap is the connection's (here bound by its awareness), and a forgery there is refused
    expect(s.send(hog, typeAt0(new RemoteClient(s.live, 10_031), s.live, 'own '))).toBe('applied'); // (builds the shadow)
    expect(s.send(s.conn('M'), typeAt0(new RemoteClient(s.live, 10_031), s.live, 'FORGED '))).toBe(REFUSED('foreign-client'));
    const bound = s.guard.bindingCount(s.live);
    expect(s.announce(hog, { clientID: 77_777 })).toBe('applied'); // the 33rd: neither recorded nor bound by awareness
    expect(s.send(hog, typeAt0(new RemoteClient(s.live, 77_777), s.live, 'hog '))).toBe('applied');
    expect(s.guard.bindingCount(s.live)).toBe(bound); // never bound: the evidence set stopped at its cap
    expect(s.send(s.conn('M'), typeAt0(new RemoteClient(s.live, 77_777), s.live, 'X '))).toBe('applied');
  });
});

describe('pinned residual (ADR 0036 §4): a regenerated client id is no longer bound by its first struct', () => {
  it('a connection that announced its old id writes at a never-seen regenerated id: applied, unbound, and forgeable', () => {
    // Yjs gives a doc a new clientID when a remote transaction touches its current one; y-protocols' Awareness keeps
    // announcing the id it was built with. So the connection's evidence names only the old id, and the new id joins the
    // stored-id class (#793). Honest regeneration needs a remote write at the doc's current id, which the guard refuses
    // (or answers unresolved) for every bound id, so on an honest page it follows only an id collision. A connection
    // whose awareness is null, or absent, keeps the old rule and binds it (update-guard.spec.ts B4).
    const s = lifetime(Y.encodeStateAsUpdate(prosemirrorJSONToYDoc(serverSchema(), SEED, 'default')));
    const victim = s.conn('V');
    expect(s.announce(victim, { clientID: B_ID })).toBe('applied');
    expect(s.send(victim, typeAt0(new RemoteClient(s.live, B_ID), s.live, 'old '))).toBe('applied'); // (builds the shadow)
    const regenerated = new RemoteClient(s.live, 4004);
    const bound = s.guard.bindingCount(s.live);
    expect(s.send(victim, typeAt0(regenerated, s.live, 'mine '))).toBe('applied');
    expect(s.guard.bindingCount(s.live)).toBe(bound);
    expect(s.send(s.conn('M'), typeAt0(new RemoteClient(s.live, 4004), s.live, 'FORGED '))).toBe('applied');
    expect(s.send(victim, typeAt0(regenerated, s.live, 'next '))).toBe('applied'); // its clocks are already taken
    expect(renderLikeABrowser(s.live).text).toBe('FORGED mine old base'); // the victim's next edit was silently dropped
  });
});

describe('the orderings through a real Hocuspocus 4.7.1 (its awareness meta, queues and CLOSE)', () => {
  const TOKENS: Record<string, string> = { A: 'A', B: 'B' };
  const settle = async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  };
  const open: Hocuspocus[] = [];
  const sockets: FakeSocket[] = [];
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => undefined)); // Hocuspocus logs each CLOSE
  afterEach(async () => {
    for (const sock of sockets.splice(0)) sock.close(1000, 'test over');
    await settle();
    for (const hp of open.splice(0)) hp.closeConnections();
    await settle();
    jest.restoreAllMocks();
  });

  /** Lifetime 2: a fresh Hocuspocus that loads `stored`. */
  async function server(stored: Uint8Array) {
    const guard = new CollabUpdateGuard({ mode: 'enforce', logger: { warn: () => undefined } });
    const hp = new Hocuspocus({
      quiet: true,
      debounce: 5,
      maxDebounce: 10,
      extensions: [
        new CollabUpdateGuardExtension(guard),
        {
          async onAuthenticate(data: any) {
            const id = TOKENS[data.token];
            if (!id) throw new Error('denied');
            return { user: { id } };
          },
        },
        {
          async onLoadDocument({ document }: { document: Y.Doc }) {
            Y.applyUpdate(document, stored);
          },
        },
      ],
    } as never);
    open.push(hp);
    const connect = async (token: string) => {
      const sock = new FakeSocket();
      sockets.push(sock);
      sock.connect(hp);
      sock.deliver(authFrame(token));
      await settle();
      return sock;
    };
    return { connect, live: () => hp.documents.get(DOC_NAME)! };
  }
  /** What a 4.7.1 provider sends after Auth: its own awareness, then (after the server's Step1) its Step2. */
  const handshake = async (sock: FakeSocket, clientID: number, clock: number, doc: Y.Doc, live: Y.Doc) => {
    sock.deliver(awarenessFrame([{ clientID, clock, state: { user: {} } }]));
    await settle();
    sock.deliver(syncFrame(Y.encodeStateAsUpdate(doc, Y.encodeStateVector(live)), SYNC.Step2));
    await settle();
  };

  it('A first: A\'s relay applies, B claims its id and its Step2 applies', async () => {
    const { stored, a, b } = lostLifetime({ storedPrefix: false }); // a never-seen id: the one a relay used to take
    const s = await server(stored);
    const aSock = await s.connect('A');
    const bSock = await s.connect('B');
    await handshake(aSock, A_ID, 1, a.doc, s.live());
    await handshake(bSock, B_ID, 1, b.doc, s.live());
    expect(aSock.closeReasons()).toEqual([]);
    expect(bSock.closeReasons()).toEqual([]);
    expect(renderLikeABrowser(s.live()).text).toBe('B-after B-lost base');
  });

  it('B first: A gets unresolved, reconnects once, and both texts are in the document', async () => {
    const { stored, a, b } = lostLifetime({ storedPrefix: true });
    const s = await server(stored);
    const aSock = await s.connect('A');
    const bSock = await s.connect('B');
    bSock.deliver(awarenessFrame([{ clientID: B_ID, clock: 1, state: { user: {} } }])); // B's startSync awareness
    await settle();
    const relay = Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(s.live()));
    await handshake(aSock, A_ID, 1, a.doc, s.live());
    expect(aSock.closeReasons()).toEqual([UNRESOLVED_REASON]);
    expect(renderLikeABrowser(s.live()).text).toBe('B-stored base'); // A's relay was never applied
    bSock.deliver(syncFrame(Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(s.live())), SYNC.Step2));
    await settle();
    const aSock2 = await s.connect('A');
    aSock2.deliver(awarenessFrame([{ clientID: A_ID, clock: 2, state: { user: {} } }]), syncFrame(relay, SYNC.Step2));
    await settle();
    expect(aSock2.closeReasons()).toEqual([]);
    expect(bSock.closeReasons()).toEqual([]);
    expect((contentOf(s.live()) as any).content[0].content[0].text).toBe('B-after B-lost B-stored base');
  });
});
