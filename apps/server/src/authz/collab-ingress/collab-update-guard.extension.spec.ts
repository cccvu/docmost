import * as Y from 'yjs';
import { Hocuspocus } from '@hocuspocus/server';
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap';
import { serverSchema } from '../page-write/prelim-content';
import {
  authFrame,
  awarenessFrame,
  contentOf,
  DOC_NAME,
  FakeSocket,
  MSG,
  readServerFrame,
  RemoteClient,
  renderLikeABrowser,
  step1Frame,
  SYNC,
  syncFrame,
  typedFrame,
} from './collab-ingress.testkit';
import * as encoding from 'lib0/encoding';
import { CollabUpdateGuardExtension } from './collab-update-guard.extension';
import { twoClientsShape } from './conflict-scan.testkit';
import {
  AWARENESS_STATE_MAX_BYTES,
  COLLAB_REFUSAL_CODE,
  CollabUpdateGuard,
  SOCKET_REFUSAL_BUDGET,
  SYNC_BURST,
  TRY_LATER_REASON,
  UNRESOLVED_REASON,
  type CollabGuardMode,
} from './update-guard';

/**
 * #781 (ADR 0036) through a REAL Hocuspocus 4.7.1: its ClientConnection queueing, its per-connection message queue
 * (one frame at a time per connection; frames of different connections interleave), its hook chain (the guard is a hook
 * in a promise chain, so every frame's check-to-apply path must stay the same length for frames to apply in the order
 * they were checked), its `Connection.close` on a hook rejection (a document-level CLOSE carrying our reason; the
 * websocket stays up), and its apply path. Frames are delivered the way `ws` does for one TCP chunk: synchronously,
 * back to back, each handed to the `ClientConnection` as the gateway does.
 */
const REFUSED = (rule: string) => `ccc:collab-update-refused:${rule}`;
const SEED = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'victim text' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'second' }] },
  ],
};
const TOKENS: Record<string, { id: string; readOnly?: boolean }> = {
  attacker: { id: 'attacker' },
  attacker2: { id: 'attacker' },
  victim: { id: 'victim' },
  peer: { id: 'peer' },
  reader: { id: 'reader', readOnly: true },
};

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

const open: Hocuspocus[] = [];
const sockets: FakeSocket[] = [];

/** `guard: 'none'` is the control arm: the same server with no guard. `refuse-unknown-mark` is a naive guard with no state. */
async function server(opts: { guard?: 'real' | 'none' | 'refuse-unknown-mark'; mode?: CollabGuardMode; seed?: Uint8Array } = {}) {
  const logs: string[] = [];
  const guard = new CollabUpdateGuard({ mode: opts.mode ?? 'enforce', logger: { warn: (m: string) => logs.push(m) } });
  const seedUpdate = opts.seed ?? Y.encodeStateAsUpdate(prosemirrorJSONToYDoc(serverSchema(), SEED, 'default'));
  const extensions: any[] = [];
  if ((opts.guard ?? 'real') === 'real') extensions.push(new CollabUpdateGuardExtension(guard));
  if (opts.guard === 'refuse-unknown-mark') {
    // A stateless guard: it refuses the one frame and remembers nothing (3.4.4 then applied the rest of the burst).
    extensions.push({
      beforeHandleMessage({ update }: { update: Uint8Array }) {
        if (Buffer.from(update).includes(Buffer.from('evilMark'))) throw { code: 4422, reason: REFUSED('unknown-mark') };
      },
    });
  }
  extensions.push(
    {
      async onAuthenticate(data: any) {
        const who = TOKENS[data.token];
        if (!who) throw new Error('denied');
        if (who.readOnly) data.connectionConfig.readOnly = true;
        return { user: { id: who.id } };
      },
    },
    {
      async onLoadDocument({ document }: { document: Y.Doc }) {
        Y.applyUpdate(document, seedUpdate);
      },
    },
  );
  const hp = new Hocuspocus({ quiet: true, extensions, debounce: 5, maxDebounce: 10 } as never);
  open.push(hp);
  const connect = async (token: string) => {
    const sock = new FakeSocket();
    sockets.push(sock);
    sock.connect(hp);
    sock.deliver(authFrame(token));
    await settle();
    return sock;
  };
  const live = () => hp.documents.get(DOC_NAME)!;
  return { hp, logs, guard, connect, live };
}

/** Sync Update frames a socket received (what a peer would apply). */
const updatesReceived = (sock: FakeSocket) =>
  sock.sent.filter((m) => {
    const f = readServerFrame(m);
    return f.type === MSG.Sync && m.length > 0;
  }).length;

beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => undefined)); // Hocuspocus logs each CLOSE
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close(1000, 'test over');
  await settle();
  for (const hp of open.splice(0)) hp.closeConnections();
  await settle();
  jest.restoreAllMocks();
});

const sameState = (a: Y.Doc, b: Y.Doc) => Buffer.from(Y.encodeStateVector(a)).equals(Buffer.from(Y.encodeStateVector(b)));
const textOf = (el: Y.XmlElement): Y.XmlText => el.toArray().find((c) => c instanceof Y.XmlText) as Y.XmlText;
const badMark = (live: Y.Doc) => new RemoteClient(live).edit(live, (f) => textOf(f.get(0) as Y.XmlElement).format(0, 3, { evilMark: {} }));
/** Refused in the SHADOW step (not by the stateless pre-pass), so the refusal rebuilds the shadow. */
const badSchema = (live: Y.Doc) => new RemoteClient(live).edit(live, (f) => (f.get(0) as Y.XmlElement).insert(0, [new Y.XmlElement('paragraph')]));

describe('#781 races through a real Hocuspocus 4.7.1', () => {
  // Hocuspocus 3.4.4 applied the frames already queued behind a refused one after its CLOSE, so only a guard that
  // remembered the refusal (`refusedConnections`) stopped them. 4.x (#1123) empties the connection's queue when a hook
  // throws, so even a stateless guard drops them now: both arms assert that, and the guard keeps its memory as defense.
  it('frames sent after a refused one are not applied (by Hocuspocus 4.x itself, and by the guard)', async () => {
    for (const arm of ['refuse-unknown-mark', 'real'] as const) {
      const s = await server({ guard: arm });
      const sock = await s.connect('attacker');
      const live = s.live();
      const ok = new RemoteClient(live).edit(live, (f) => textOf(f.get(1) as Y.XmlElement).insert(0, 'A '));
      const after = new RemoteClient(live).edit(live, (f) => textOf(f.get(1) as Y.XmlElement).insert(0, 'C '));
      sock.deliver(syncFrame(ok), syncFrame(badMark(live)), syncFrame(after));
      await settle();
      expect(sock.closeReasons()).toEqual([REFUSED('unknown-mark')]);
      const text = renderLikeABrowser(live).text;
      expect(text).toContain('A ');
      expect(text).not.toContain('C '); // control too: 4.x drops the refused connection's queued frames
    }
  });

  it('burst [A ok, B bad] + [C reusing A\'s ids, D formatting them]: the rebuild after B keeps in-flight A, so D is refused', async () => {
    for (const arm of ['none', 'real'] as const) {
      const s = await server({ guard: arm });
      const peerSock = await s.connect('peer'); // keeps the document loaded after both attacker sessions are closed
      const one = await s.connect('attacker');
      const two = await s.connect('attacker2');
      const live = s.live();
      // A: a codeBlock at client 5555; C: the SAME ids as a paragraph; D: bold over that text (allowed in a paragraph only).
      const a = new RemoteClient(live, 5555);
      const updA = a.edit(live, (f) => {
        const code = new Y.XmlElement('codeBlock');
        code.insert(0, [new Y.XmlText('code')]);
        f.insert(2, [code]);
      });
      const c = new RemoteClient(live, 5555);
      const updC = c.edit(live, (f) => {
        const p = new Y.XmlElement('paragraph');
        p.insert(0, [new Y.XmlText('para')]);
        f.insert(2, [p]);
      });
      const d = new RemoteClient(c.doc, 6666);
      const updD = d.edit(c.doc, (f) => textOf(f.get(2) as Y.XmlElement).format(0, 4, { bold: {} }));
      if (arm === 'none') {
        one.deliver(syncFrame(updA));
        two.deliver(syncFrame(updC), syncFrame(updD));
        await settle();
        // Control: D's bold landed in A's codeBlock (C's ids were already taken); every peer deletes the codeBlock.
        expect(renderLikeABrowser(live)).toMatchObject({ deleted: true });
        expect(renderLikeABrowser(live).text).not.toContain('code');
        continue;
      }
      // B is refused in the shadow step, so the shadow is rebuilt while A is accepted but not yet applied to live.
      one.deliver(syncFrame(updA), syncFrame(badSchema(live)));
      two.deliver(syncFrame(updC), syncFrame(updD));
      await settle();
      expect(one.closeReasons()).toEqual([REFUSED('schema')]);
      expect(two.closeReasons()).toEqual([REFUSED('schema')]);
      expect(renderLikeABrowser(live)).toMatchObject({ deleted: false, threw: false });
      expect(renderLikeABrowser(live).text).toContain('code');
      // #790: a refusal no longer rebuilds the shadow (it still holds D); the next frame rebuilds it from live and passes.
      expect(sameState(s.guard.shadowOf(live)!, live)).toBe(false);
      peerSock.deliver(syncFrame(new RemoteClient(live).edit(live, (f) => textOf(f.get(1) as Y.XmlElement).insert(0, 'peer '))));
      await settle();
      expect(peerSock.closeReasons()).toEqual([]);
      expect(contentOf(s.guard.shadowOf(live)!)).toEqual(contentOf(live));
    }
  });

  it('a frame whose dependency is missing is unresolved (the recoverable reason)', async () => {
    const s = await server();
    const sock = await s.connect('victim');
    const live = s.live();
    const c = new RemoteClient(live);
    c.edit(live, (f) => textOf(f.get(0) as Y.XmlElement).insert(0, 'one '));
    const sv = Y.encodeStateVector(c.doc);
    c.doc.transact(() => textOf(c.fragment.get(0) as Y.XmlElement).insert(0, 'two '));
    sock.deliver(syncFrame(Y.encodeStateAsUpdate(c.doc, sv)));
    await settle();
    expect(sock.closeReasons()).toEqual([UNRESOLVED_REASON]);
    expect(live.store.pendingStructs).toBeNull();
  });

  it('a read-only connection\'s update is skipped (never applied, no CLOSE)', async () => {
    const s = await server();
    const sock = await s.connect('reader');
    const live = s.live();
    const before = Y.encodeStateAsUpdate(live);
    sock.deliver(syncFrame(badMark(live)));
    await settle();
    expect(sock.closeReasons()).toEqual([]);
    expect(Buffer.from(Y.encodeStateAsUpdate(live)).equals(Buffer.from(before))).toBe(true);
  });

  it.each([
    ['Sync Update', SYNC.Update, MSG.Sync],
    ['Sync Step2', SYNC.Step2, MSG.Sync],
    ['SyncReply Step2', SYNC.Step2, MSG.SyncReply],
    ['SyncReply Update', SYNC.Update, MSG.SyncReply],
  ])('an invalid %s is refused and not broadcast', async (_name, subtype, type) => {
    const s = await server();
    const sock = await s.connect('attacker');
    const peer = await s.connect('peer');
    const live = s.live();
    const received = updatesReceived(peer);
    sock.deliver(syncFrame(badMark(live), subtype, type));
    await settle();
    expect(sock.closeReasons()).toEqual([REFUSED('unknown-mark')]);
    expect(updatesReceived(peer)).toBe(received);
    expect(renderLikeABrowser(live)).toMatchObject({ deleted: false, threw: false });
  });

  it('report mode: the frame applies, nothing is closed, the refusal is logged', async () => {
    const s = await server({ mode: 'report' });
    const sock = await s.connect('attacker');
    sock.deliver(syncFrame(badMark(s.live())));
    await settle();
    expect(sock.closeReasons()).toEqual([]);
    expect(renderLikeABrowser(s.live()).deleted).toBe(true); // it applied: exactly today's behaviour
    expect(s.logs.some((l) => l.includes('"rule":"unknown-mark"'))).toBe(true);
  });

  it('a throwing shadow mirror never wedges the live document: later updates still broadcast', async () => {
    const s = await server();
    const editor = await s.connect('victim');
    const peer = await s.connect('peer');
    const live = s.live();
    editor.deliver(syncFrame(new RemoteClient(live).edit(live, (f) => textOf(f.get(0) as Y.XmlElement).insert(0, 'a '))));
    await settle();
    const shadow = s.guard.shadowOf(live)!;
    Object.defineProperty(shadow, 'store', { get: () => { throw new Error('mirror boom'); } });
    const received = updatesReceived(peer);
    live.transact(() => textOf(live.getXmlFragment('default').get(0) as Y.XmlElement).insert(0, 'server1 '));
    await settle(); // 4.x merges one event-loop turn's updates into one broadcast (flushDelay 0): one per turn here
    live.transact(() => textOf(live.getXmlFragment('default').get(0) as Y.XmlElement).insert(0, 'server2 '));
    await settle();
    expect(updatesReceived(peer)).toBe(received + 2);
    editor.deliver(syncFrame(new RemoteClient(live).edit(live, (f) => textOf(f.get(0) as Y.XmlElement).insert(0, 'b '))));
    await settle();
    expect(editor.closeReasons()).toEqual([]);
    expect(renderLikeABrowser(live).text).toContain('b server2 server1 a victim text');
  });

  it(`after ${SOCKET_REFUSAL_BUDGET} refusals the websocket itself is closed`, async () => {
    const s = await server();
    const sock = await s.connect('attacker');
    for (let i = 0; i < SOCKET_REFUSAL_BUDGET; i++) {
      if (i > 0) {
        sock.deliver(authFrame('attacker')); // the client re-authenticates on the same socket
        await settle();
      }
      sock.deliver(syncFrame(badMark(s.live())));
      await settle();
    }
    expect(sock.closed).toEqual({ code: COLLAB_REFUSAL_CODE, reason: REFUSED('unknown-mark') });
  });
});

describe('#781 B4 through Hocuspocus: client ids bind to users', () => {
  it('a victim bound by awareness: a forged struct at its next clock is foreign-client; a reader or an echo cannot pre-claim it', async () => {
    const s = await server();
    const reader = await s.connect('reader');
    const victim = await s.connect('victim');
    const attacker = await s.connect('attacker');
    reader.deliver(awarenessFrame([{ clientID: 1001, clock: 1, state: { user: {} } }])); // a reader never binds
    await settle();
    // A writer's provider echoes the state Hocuspocus relayed (the clock its Document's awareness already holds): no bind.
    attacker.deliver(awarenessFrame([{ clientID: 1001, clock: 1, state: { user: {} } }]));
    victim.deliver(awarenessFrame([{ clientID: 1001, clock: 2, state: { user: { name: 'V' } } }]));
    await settle();
    const live = s.live();
    const mine = new RemoteClient(live, 1001);
    victim.deliver(syncFrame(mine.edit(live, (f) => textOf(f.get(0) as Y.XmlElement).insert(0, 'MINE '))));
    await settle();
    const forger = new RemoteClient(live, 1001);
    attacker.deliver(syncFrame(forger.edit(live, (f) => textOf(f.get(0) as Y.XmlElement).insert(0, 'FORGED '))));
    await settle();
    expect(attacker.closeReasons()).toEqual([REFUSED('foreign-client')]);
    expect(victim.closeReasons()).toEqual([]);
    victim.deliver(syncFrame(mine.edit(live, (f) => textOf(f.get(0) as Y.XmlElement).insert(0, 'AGAIN '))));
    await settle();
    expect(renderLikeABrowser(live).text).toContain('AGAIN MINE victim text');
  });
});

describe('#790 frame bounds through a real Hocuspocus 4.7.1', () => {
  const errors = () => (console.error as jest.Mock).mock.calls.length;
  const BURST = 5;

  it.each([
    ['an Auth frame on an established session (a non-Token subtype: 4.7.1 logs it)', () => authFrame('attacker', DOC_NAME, 1), 'auth'],
    ['a type 4.7.1 handles only server-to-client (SyncStatus)', () => typedFrame(MSG.SyncStatus, (e) => encoding.writeVarInt(e, 1)), 'message-type'],
    ['an unknown type', () => typedFrame(42), 'message-type'],
  ])('%s: refused with ONE Hocuspocus log line, where the control logs one per frame and stays up', async (_name, make, rule) => {
    for (const arm of ['none', 'real'] as const) {
      const s = await server({ guard: arm });
      const sock = await s.connect('attacker');
      const before = errors();
      sock.deliver(...Array.from({ length: BURST }, make));
      await settle();
      if (arm === 'none') {
        expect(errors() - before).toBe(BURST);
        expect(sock.closeReasons()).toEqual([]);
        continue;
      }
      expect(errors() - before).toBe(1); // Connection.processMessages's "closing connection … because of exception"
      expect(sock.closeReasons()).toEqual([REFUSED(rule)]);
    }
  });

  it('a Token-subtype Auth on an established session (4.7.1 re-runs onTokenSync for it) is refused auth', async () => {
    const s = await server();
    const sock = await s.connect('attacker');
    sock.deliver(authFrame('attacker'));
    await settle();
    expect(sock.closeReasons()).toEqual([REFUSED('auth')]);
  });

  it(`a SyncStep1 flood past ${SYNC_BURST} closes the SOCKET 1013 and sends no refusal (the editor retries); so does a reader's Step2 flood`, async () => {
    const s = await server();
    const writer = await s.connect('attacker');
    writer.deliver(...Array.from({ length: SYNC_BURST + 5 }, () => step1Frame(new Y.Doc())));
    await settle();
    expect(writer.closed).toEqual({ code: 1013, reason: TRY_LATER_REASON });
    expect(writer.closeReasons()).toEqual([]); // no document CLOSE: a 4422 reason would detach the editor for good
    const again = await s.connect('attacker'); // a reconnect gets no fresh budget
    again.deliver(step1Frame(new Y.Doc()));
    await settle();
    expect(again.closed).toEqual({ code: 1013, reason: TRY_LATER_REASON });
    const reader = await s.connect('reader');
    const step2 = syncFrame(Y.encodeStateAsUpdate(s.live()), SYNC.Step2);
    reader.deliver(step1Frame(s.live()), ...Array.from({ length: SYNC_BURST }, () => step2));
    await settle();
    expect(reader.closed).toEqual({ code: 1013, reason: TRY_LATER_REASON });
    expect(reader.closeReasons()).toEqual([]);
  });

  it('an honest open passes for a writer and a reader: Step1, Step2, awareness, then updates', async () => {
    const s = await server();
    for (const who of ['victim', 'reader']) {
      const sock = await s.connect(who);
      const client = new RemoteClient(s.live());
      sock.deliver(
        step1Frame(client.doc),
        syncFrame(client.edit(s.live(), (f) => textOf(f.get(1) as Y.XmlElement).insert(0, `${who} `)), SYNC.Step2),
        awarenessFrame([{ clientID: client.doc.clientID, state: { user: { name: who } } }]),
      );
      for (let i = 0; i < 3 * SYNC_BURST; i++) sock.deliver(syncFrame(client.edit(s.live(), (f) => textOf(f.get(1) as Y.XmlElement).insert(0, `${i}`))));
      await settle();
      expect(sock.closeReasons()).toEqual([]);
    }
  });

  it('a reader\'s oversized awareness state is refused before Hocuspocus parses and relays it (the control relays it)', async () => {
    for (const arm of ['none', 'real'] as const) {
      const s = await server({ guard: arm });
      await s.connect('peer'); // keeps the document loaded after the reader's session is closed
      const reader = await s.connect('reader');
      reader.deliver(awarenessFrame([{ clientID: 4040, state: { name: 'x'.repeat(AWARENESS_STATE_MAX_BYTES) } }]));
      await settle();
      const relayed = (s.live() as unknown as { awareness: { getStates(): Map<number, unknown> } }).awareness.getStates().has(4040);
      if (arm === 'none') {
        expect(relayed).toBe(true);
        expect(reader.closeReasons()).toEqual([]);
        continue;
      }
      expect(relayed).toBe(false);
      expect(reader.closeReasons()).toEqual([REFUSED('awareness')]);
    }
  });

  it('a refusal leaves the shadow as it is; the next honest frame rebuilds it and passes; bindings stay constant over K refusals', async () => {
    const s = await server();
    const peer = await s.connect('peer');
    const live = s.live();
    const pc = new RemoteClient(live, 7777);
    const honest = (t: string) => {
      pc.sync(live);
      return syncFrame(pc.edit(live, (f) => textOf(f.get(1) as Y.XmlElement).insert(0, t)));
    };
    peer.deliver(honest('p0 '));
    await settle();
    const counts: number[] = [];
    for (let k = 1; k <= 5; k++) {
      const shadow = s.guard.shadowOf(live)!;
      expect(shadow).toBeTruthy();
      const attacker = await s.connect('attacker');
      attacker.deliver(syncFrame(badSchema(live))); // refused in the shadow step
      await settle();
      expect(attacker.closeReasons()).toEqual([REFUSED('schema')]);
      expect(s.guard.shadowOf(live)).toBe(shadow); // not rebuilt by the refusal
      expect(sameState(shadow, live)).toBe(false); // it still holds the refused frame
      peer.deliver(honest(`p${k} `));
      await settle();
      expect(peer.closeReasons()).toEqual([]);
      expect(s.guard.shadowOf(live)).not.toBe(shadow); // rebuilt by the next frame that needed it
      expect(contentOf(s.guard.shadowOf(live)!)).toEqual(contentOf(live));
      expect(renderLikeABrowser(live).text).toContain(`p${k} `);
      counts.push(s.guard.bindingCount(live));
    }
    expect(new Set(counts)).toEqual(new Set([counts[0]]));
  });
});

describe('#816 the conflict-scan meter through a real Hocuspocus 4.7.1', () => {
  it('a frame past the scan cap closes that session with conflict-scan, applies nowhere, and an honest peer keeps editing', async () => {
    for (const arm of ['none', 'real'] as const) {
      const shape = twoClientsShape(1100); // 1100 x 1100 steps: the meter's cap is 1e6 per frame
      const s = await server({ guard: arm, seed: Y.encodeStateAsUpdate(shape.base) });
      const peer = await s.connect('peer');
      const attacker = await s.connect('attacker');
      const live = s.live();
      const before = Y.encodeStateAsUpdate(live);
      const relayed = updatesReceived(peer);
      attacker.deliver(syncFrame(shape.frame));
      await settle();
      if (arm === 'none') {
        // Control: Hocuspocus applies it and relays it to every peer (who each pay the same walk again).
        expect(updatesReceived(peer)).toBeGreaterThan(relayed);
        expect(Buffer.from(Y.encodeStateAsUpdate(live)).equals(Buffer.from(before))).toBe(false);
        continue;
      }
      expect(attacker.closeReasons()).toEqual([REFUSED('conflict-scan')]);
      expect(Buffer.from(Y.encodeStateAsUpdate(live)).equals(Buffer.from(before))).toBe(true);
      expect(updatesReceived(peer)).toBe(relayed); // nothing reached the peer
      expect(s.logs.some((l) => l.includes('"rule":"conflict-scan"'))).toBe(true);
      const honest = new RemoteClient(live).edit(live, (f) => textOf(f.get(0) as Y.XmlElement).insert(0, 'honest '));
      peer.deliver(syncFrame(honest));
      await settle();
      expect(peer.closeReasons()).toEqual([]);
      expect(textOf(live.getXmlFragment('default').get(0) as Y.XmlElement).toString()).toMatch(/^honest /);
      expect(contentOf(s.guard.shadowOf(live)!)).toEqual(contentOf(live)); // rebuilt from live after the refusal
    }
  });
});
