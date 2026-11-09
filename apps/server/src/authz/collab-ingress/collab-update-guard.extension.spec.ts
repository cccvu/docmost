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
  SYNC,
  syncFrame,
} from './collab-ingress.testkit';
import { CollabUpdateGuardExtension } from './collab-update-guard.extension';
import { COLLAB_REFUSAL_CODE, CollabUpdateGuard, SOCKET_REFUSAL_BUDGET, UNRESOLVED_REASON, type CollabGuardMode } from './update-guard';

/**
 * #781 (ADR 0036) through a REAL Hocuspocus 3.4.4: its ClientConnection queueing, its hook chain (the guard is a hook in
 * a promise chain, so every frame's chain must stay the same length for frames to apply in FIFO order), its
 * `Connection.close` on a hook rejection (a document-level CLOSE carrying our reason; the websocket stays up), and its
 * apply path. Frames are delivered the way `ws` does for one TCP chunk: synchronously, back to back.
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

/** `guard: false` is the control arm: the same server with no guard. `refuseOnly` is a naive guard with no state. */
async function server(opts: { guard?: 'real' | 'none' | 'refuse-unknown-mark'; mode?: CollabGuardMode } = {}) {
  const logs: string[] = [];
  const guard = new CollabUpdateGuard({ mode: opts.mode ?? 'enforce', logger: { warn: (m: string) => logs.push(m) } });
  const seedUpdate = Y.encodeStateAsUpdate(prosemirrorJSONToYDoc(serverSchema(), SEED, 'default'));
  const extensions: any[] = [];
  if ((opts.guard ?? 'real') === 'real') extensions.push(new CollabUpdateGuardExtension(guard));
  if (opts.guard === 'refuse-unknown-mark') {
    // What Hocuspocus does with a stateless guard: it refuses the one frame and keeps applying the rest of the burst.
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
    hp.handleConnection(sock as never, { headers: {}, url: '/' } as never);
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

const textOf = (el: Y.XmlElement): Y.XmlText => el.toArray().find((c) => c instanceof Y.XmlText) as Y.XmlText;
const badMark = (live: Y.Doc) => new RemoteClient(live).edit(live, (f) => textOf(f.get(0) as Y.XmlElement).format(0, 3, { evilMark: {} }));
/** Refused in the SHADOW step (not by the stateless pre-pass), so the refusal rebuilds the shadow. */
const badSchema = (live: Y.Doc) => new RemoteClient(live).edit(live, (f) => (f.get(0) as Y.XmlElement).insert(0, [new Y.XmlElement('paragraph')]));

describe('#781 races through a real Hocuspocus 3.4.4', () => {
  it('frames sent after a refused one are not applied (Hocuspocus 3.4.4 would apply them after the CLOSE)', async () => {
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
      if (arm === 'refuse-unknown-mark') expect(text).toContain('C '); // control: applied after the CLOSE
      else expect(text).not.toContain('C ');
    }
  });

  it('burst [A ok, B bad] + [C reusing A\'s ids, D formatting them]: the rebuild after B keeps in-flight A, so D is refused', async () => {
    for (const arm of ['none', 'real'] as const) {
      const s = await server({ guard: arm });
      await s.connect('peer'); // keeps the document loaded after both attacker sessions are closed
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
  it('a victim bound by awareness: a forged struct at its next clock is foreign-client; a reader cannot pre-claim it', async () => {
    const s = await server();
    const reader = await s.connect('reader');
    const victim = await s.connect('victim');
    const attacker = await s.connect('attacker');
    reader.deliver(awarenessFrame([{ clientID: 1001, state: { user: {} } }])); // a reader never binds
    victim.deliver(awarenessFrame([{ clientID: 1001, state: { user: { name: 'V' } } }]));
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
