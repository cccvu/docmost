import * as Y from 'yjs';
import { initProseMirrorDoc, prosemirrorJSONToYDoc, updateYFragment } from '@tiptap/y-tiptap';
import { Node as PMNode } from '@tiptap/pm/model';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { jsonToHtml } from '../../collaboration/collaboration.util';
import { serverSchema } from '../page-write/prelim-content';
import { isDuplicateWriteKey, recordWriteKey, WRITE_IDEM_MAP } from '../page-write/write-idem';
import {
  ALL_NODES_DOC,
  awarenessFrame,
  contentOf,
  deepJson,
  DOC_NAME,
  MSG,
  RemoteClient,
  renderLikeABrowser,
  spliceVarString,
  statelessFrame,
  SYNC,
  syncFrame,
} from './collab-ingress.testkit';
import { STRING_ATTRS } from './content-rules';
import { COLLAB_REFUSAL_CODE, CollabUpdateGuard, SOCKET_REFUSAL_BUDGET, UNRESOLVED_REASON, type CollabGuardMode } from './update-guard';

/**
 * #781 (ADR 0036): the collab update guard refuses, BEFORE it applies, a frame that would make any browser's y-tiptap
 * delete content (its delete-on-error syncs to everyone), crash a render, or wedge the server's store; and accepts
 * everything an honest editor sends. Hocuspocus is stood in for by `send`: the guard first, then `Y.applyUpdate` with
 * the connection as origin, exactly what `MessageReceiver` does after `beforeHandleMessage` resolves.
 *
 * Every attack has a CONTROL arm (the same bytes applied with no guard, proving the damage) and a TREATMENT arm (the
 * refusal, the live document unchanged, the peer that receives every broadcast unchanged).
 */
const schema = serverSchema();
const REFUSED = (rule: string) => `ccc:collab-update-refused:${rule}`;

type Conn = { readOnly: boolean; webSocket: { close: jest.Mock }; context: { user: { id: string } } };

function setup(opts: { mode?: CollabGuardMode; seed?: unknown | Y.Doc; seedY?: (f: Y.XmlFragment, d: Y.Doc) => void; legacy?: Uint8Array } = {}) {
  const live = new Y.Doc() as Y.Doc & { name: string };
  live.name = DOC_NAME;
  if (opts.seed) {
    const seedDoc = opts.seed instanceof Y.Doc ? opts.seed : prosemirrorJSONToYDoc(schema, opts.seed, 'default');
    Y.applyUpdate(live, Y.encodeStateAsUpdate(seedDoc));
  }
  if (opts.seedY) {
    const d = new Y.Doc();
    d.transact(() => opts.seedY!(d.getXmlFragment('default'), d));
    Y.applyUpdate(live, Y.encodeStateAsUpdate(d));
  }
  if (opts.legacy) Y.applyUpdate(live, opts.legacy); // stored before the guard ever saw the document
  const logs: string[] = [];
  const guard = new CollabUpdateGuard({ mode: opts.mode ?? 'enforce', logger: { warn: (m: string) => logs.push(m) } });
  // The peer receives every update the live document broadcasts.
  const peer = new Y.Doc();
  if (!opts.legacy) {
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(live));
    live.on('update', (u: Uint8Array) => Y.applyUpdate(peer, u));
  }
  const conn = (id: string, readOnly = false): Conn => ({ readOnly, webSocket: { close: jest.fn() }, context: { user: { id } } });
  /** One frame through the guard; when it passes, applied the way Hocuspocus applies it. */
  const deliver = (c: Conn, frame: Uint8Array, apply?: Uint8Array): string => {
    try {
      const ret = guard.check({ connection: c, document: live, update: frame, context: c.context });
      expect(ret).toBeUndefined(); // never a promise
    } catch (err: any) {
      expect(err).toEqual({ code: COLLAB_REFUSAL_CODE, reason: expect.any(String) });
      return err.reason;
    }
    if (apply) Y.applyUpdate(live, apply, c);
    return 'applied';
  };
  const send = (c: Conn, update: Uint8Array, subtype: number = SYNC.Update, type: number = MSG.Sync) =>
    deliver(c, syncFrame(update, subtype, type), update);
  const snapshot = () => ({ live: Y.encodeStateAsUpdate(live), peer: Y.encodeStateAsUpdate(peer) });
  return { live, guard, peer, logs, conn, send, deliver, snapshot };
}

/** The same update with no guard, on a copy: the control arm. */
function unguarded(base: Y.Doc, update: Uint8Array): Y.Doc {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(base));
  Y.applyUpdate(copy, update);
  return copy;
}

/** First element named `name` (depth-first) in the default fragment. */
function find(doc: Y.Doc, name: string, nth = 0): Y.XmlElement {
  const stack: Y.XmlElement[] = (doc.getXmlFragment('default').toArray() as Y.XmlElement[]).reverse();
  let seen = 0;
  while (stack.length) {
    const el = stack.pop()!;
    if (!(el instanceof Y.XmlElement)) continue;
    if (el.nodeName === name && seen++ === nth) return el;
    stack.push(...(el.toArray() as Y.XmlElement[]).reverse());
  }
  throw new Error(`no ${name}`);
}
const textOf = (el: Y.XmlElement): Y.XmlText => el.toArray().find((c) => c instanceof Y.XmlText) as Y.XmlText;
const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

/** Treatment: refused with `reason`, nothing changed on the live document or the peer. */
function expectRefused(s: ReturnType<typeof setup>, c: Conn, update: Uint8Array, reason: string, subtype: number = SYNC.Update) {
  const before = s.snapshot();
  expect(s.send(c, update, subtype)).toBe(reason);
  const after = s.snapshot();
  expect(sameBytes(after.live, before.live)).toBe(true);
  expect(sameBytes(after.peer, before.peer)).toBe(true);
  expect(renderLikeABrowser(s.peer)).toMatchObject({ deleted: false, threw: false });
}

const SEED = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'victim text' }] }] };

describe('#781 case 1: a non-string URL or label is refused (every viewer crashed on it)', () => {
  it('a link mark whose href is an object (a FORMAT): control crashes the renderer; treatment refuses string-attr', () => {
    const s = setup({ seed: SEED });
    const attacker = new RemoteClient(s.live);
    const u = attacker.edit(s.live, () => textOf(find(attacker.doc, 'paragraph')).format(0, 6, { link: { href: { evil: 1 } } }));
    expect(() => jsonToHtml(contentOf(unguarded(s.live, u)))).toThrow(); // control
    expectRefused(s, s.conn('attacker'), u, REFUSED('string-attr'));
  });

  it('an image whose src is an object (an ATTRIBUTE): control stores it for every browser; treatment refuses', () => {
    const s = setup({ seed: SEED });
    const attacker = new RemoteClient(s.live);
    const u = attacker.edit(s.live, (f) => {
      const img = new Y.XmlElement('image');
      img.setAttribute('src', { evil: 1 } as never);
      f.insert(1, [img]);
    });
    expect((contentOf(unguarded(s.live, u)) as any).content[1].attrs.src).toEqual({ evil: 1 }); // control
    expectRefused(s, s.conn('attacker'), u, REFUSED('string-attr'));
  });

  it.each([...STRING_ATTRS])('%s set to a non-string is refused; a string is accepted', (entry) => {
    const [kind, rest] = entry.split(' ');
    const [type, attr] = rest.split('.');
    const s = setup({ seed: ALL_NODES_DOC });
    const edit = (value: unknown) => {
      const c = new RemoteClient(s.live);
      return c.edit(s.live, () => {
        if (kind === 'mark') textOf(find(c.doc, 'paragraph')).format(0, 2, { [type]: { [attr]: value } });
        else find(c.doc, type).setAttribute(attr, value as never);
      });
    };
    expectRefused(s, s.conn('attacker'), edit(7), REFUSED('string-attr'));
    expect(s.send(s.conn('honest'), edit('https://example.com/ok'))).toBe('applied');
  });
});

describe('#781 case 2: only XmlElement/XmlText content, so the store never wedges and no render throws', () => {
  const cases: Array<[string, (f: Y.XmlFragment) => void, string]> = [
    ['a plain value (ContentAny) in default', (f) => f.insert(0, [{ evil: 1 } as never]), 'child-kind'],
    ['a string value in default', (f) => f.insert(0, ['str' as never]), 'child-kind'],
    ['a Y.Map in default', (f) => f.insert(0, [new Y.Map() as never]), 'content-kind'],
    ['an XmlHook in default', (f) => f.insert(0, [new Y.XmlHook('h') as never]), 'content-kind'],
    ['a top-level XmlText', (f) => f.insert(0, [new Y.XmlText('loose')]), 'child-kind'],
    ['an EMPTY top-level XmlText', (f) => f.insert(0, [new Y.XmlText()]), 'child-kind'],
    ['an embed in an XmlText', (f) => textOf(f.get(0) as Y.XmlElement).insertEmbed(2, { a: 1 }), 'content-kind'],
    ['a plain Y.Text in a paragraph', (f) => (f.get(0) as Y.XmlElement).insert(0, [new Y.Text('x') as never]), 'content-kind'],
    ['an XmlHook in a paragraph', (f) => (f.get(0) as Y.XmlElement).insert(0, [new Y.XmlHook('h') as never]), 'content-kind'],
    ['a nested XmlFragment', (f) => (f.get(0) as Y.XmlElement).insert(0, [new Y.XmlFragment() as never]), 'content-kind'],
  ];
  it.each(cases)('%s: control breaks the store or a render; treatment refuses', (_name, change, rule) => {
    const s = setup({ seed: SEED });
    const u = new RemoteClient(s.live).edit(s.live, change);
    const copy = unguarded(s.live, u);
    let storeThrew = false;
    try {
      contentOf(copy);
    } catch {
      storeThrew = true;
    }
    const render = renderLikeABrowser(copy);
    expect(storeThrew || render.threw || render.deleted || JSON.stringify(contentOf(copy)).includes('"text":{')).toBe(true); // control
    expectRefused(s, s.conn('attacker'), u, REFUSED(rule));
  });
});

describe('#781 case 3: what y-tiptap would delete on every peer is refused', () => {
  const LIST = {
    type: 'doc',
    content: [
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item text' }] }] }] },
      { type: 'codeBlock', content: [{ type: 'text', text: 'code text' }] },
      { type: 'details', content: [{ type: 'detailsSummary', content: [{ type: 'text', text: 'sum' }] }, { type: 'detailsContent', content: [{ type: 'paragraph' }] }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'victim text' }] },
    ],
  };
  const cases: Array<[string, (d: Y.Doc) => void, string]> = [
    ['an unknown mark', (d) => textOf(find(d, 'paragraph', 2)).format(0, 3, { evilMark: {} }), 'unknown-mark'],
    ['a hashed unknown mark', (d) => textOf(find(d, 'paragraph', 2)).format(0, 3, { 'evilMark--ABCDEFGH': {} }), 'unknown-mark'],
    ['bold in a codeBlock', (d) => textOf(find(d, 'codeBlock')).format(0, 4, { bold: {} }), 'schema'],
    ['a paragraph in a paragraph', (d) => find(d, 'paragraph', 2).insert(0, [new Y.XmlElement('paragraph')]), 'schema'],
    ['a listItem whose first child is a bulletList', (d) => {
      const list = new Y.XmlElement('bulletList');
      const li = new Y.XmlElement('listItem');
      const p = new Y.XmlElement('paragraph');
      p.insert(0, [new Y.XmlText('nested')]);
      li.insert(0, [p]);
      list.insert(0, [li]);
      find(d, 'listItem').insert(0, [list]);
    }, 'schema'],
    ['a second detailsSummary', (d) => {
      const sum = new Y.XmlElement('detailsSummary');
      sum.insert(0, [new Y.XmlText('two')]);
      find(d, 'details').insert(1, [sum]);
    }, 'schema'],
    ['a block inside a paragraph', (d) => find(d, 'paragraph', 2).insert(1, [new Y.XmlElement('image')]), 'schema'],
    ['an element of an unknown type', (d) => d.getXmlFragment('default').insert(0, [new Y.XmlElement('evilNode')]), 'schema'],
  ];
  it.each(cases)('%s: control makes the peer delete content; treatment refuses', (_name, change, rule) => {
    const s = setup({ seed: LIST });
    const attacker = new RemoteClient(s.live);
    const u = attacker.edit(s.live, (_f, d) => change(d));
    const control = renderLikeABrowser(unguarded(s.live, u));
    expect(control.deleted || control.threw).toBe(true);
    expectRefused(s, s.conn('attacker'), u, REFUSED(rule));
  });
});

describe('#781 transition semantics', () => {
  it('a legacy invalid parent (found by the build audit) is reported, not refused; a NEW violation still is', () => {
    const s = setup({
      seedY: (f) => {
        const outer = new Y.XmlElement('paragraph');
        const inner = new Y.XmlElement('paragraph');
        inner.insert(0, [new Y.XmlText('inner')]);
        outer.insert(0, [new Y.XmlText('outer'), inner]);
        const ok = new Y.XmlElement('paragraph');
        ok.insert(0, [new Y.XmlText('fine')]);
        f.insert(0, [outer, ok]);
      },
    });
    const editor = new RemoteClient(s.live);
    const typing = editor.edit(s.live, (f) => textOf(f.get(0) as Y.XmlElement).insert(5, ' typed'));
    expect(s.send(s.conn('editor'), typing)).toBe('applied');
    expect(s.logs.some((l) => l.startsWith('collab_stored_content_invalid'))).toBe(true);
    expect(s.logs.join('\n')).not.toContain('inner'); // no content in the audit log
    const fresh = new RemoteClient(s.live).edit(s.live, (f) => (f.get(1) as Y.XmlElement).insert(0, [new Y.XmlElement('paragraph')]));
    expect(s.send(s.conn('editor'), fresh)).toBe(REFUSED('schema'));
  });

  const LIST2 = {
    type: 'doc',
    content: [
      { type: 'bulletList', content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }] },
      ] },
      { type: 'paragraph', content: [{ type: 'text', text: 'after' }] },
    ],
  };
  it('two concurrent deletes that empty a list are both accepted (an empty container loses nothing)', () => {
    const s = setup({ seed: LIST2 });
    const one = new RemoteClient(s.live);
    const two = new RemoteClient(s.live);
    const u1 = one.edit(s.live, () => find(one.doc, 'bulletList').delete(0, 1));
    const u2 = two.edit(s.live, () => find(two.doc, 'bulletList').delete(1, 1));
    expect(s.send(s.conn('one'), u1)).toBe('applied');
    expect(s.send(s.conn('two'), u2)).toBe('applied');
    expect(renderLikeABrowser(s.live).text).toBe('after');
  });

  it('a concurrent race that would leave a NON-empty listItem invalid: the second frame is refused, the peer keeps the content', () => {
    const s = setup({
      seed: {
        type: 'doc',
        content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'p1' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'p2' }] },
          { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'nested' }] }] }] },
        ] }] }],
      },
    });
    const one = new RemoteClient(s.live);
    const two = new RemoteClient(s.live);
    const u1 = one.edit(s.live, () => find(one.doc, 'listItem').delete(0, 1));
    const u2 = two.edit(s.live, () => find(two.doc, 'listItem').delete(1, 1));
    // Control: both applied, every browser deletes the whole listItem (and "nested" with it).
    const control = unguarded(unguarded(s.live, u1), u2);
    expect(renderLikeABrowser(control).text).not.toContain('nested');
    expect(s.send(s.conn('one'), u1)).toBe('applied');
    expect(s.send(s.conn('two'), u2)).toBe(REFUSED('schema'));
    expect(renderLikeABrowser(s.peer)).toMatchObject({ deleted: false, text: 'p2nested' });
  });
});

describe('#781 B4: a client id is bound to its user (forged clocks)', () => {
  const victimSetup = () => {
    const s = setup({ seed: SEED });
    const victim = new RemoteClient(s.live, 1001);
    const vc = s.conn('victim');
    return { s, victim, vc };
  };
  /** An attacker writing AT the victim's next clock: a replica that impersonates the victim's client id. */
  const forge = (s: ReturnType<typeof setup>, victimId: number, text: string) => {
    const forger = new RemoteClient(s.live, victimId);
    return forger.edit(s.live, () => textOf(find(forger.doc, 'paragraph')).insert(0, text));
  };

  it('control: with no binding the forged struct is applied and the victim\'s next edit is silently dropped', () => {
    const { s, victim } = victimSetup();
    const live2 = unguarded(s.live, forge(s, 1001, 'FORGED '));
    Y.applyUpdate(live2, victim.edit(live2, () => textOf(find(victim.doc, 'paragraph')).insert(0, 'MINE ')));
    expect(renderLikeABrowser(live2).text).not.toContain('MINE');
  });

  it('bound by a non-readOnly awareness frame: the forged struct is foreign-client; the victim\'s own edits pass', () => {
    const { s, victim, vc } = victimSetup();
    expect(s.deliver(vc, awarenessFrame([{ clientID: 1001, state: { user: { name: 'V' } } }]))).toBe('applied');
    expectRefused(s, s.conn('attacker'), forge(s, 1001, 'FORGED '), REFUSED('foreign-client'));
    expect(s.send(vc, victim.edit(s.live, () => textOf(find(victim.doc, 'paragraph')).insert(0, 'MINE ')))).toBe('applied');
    expect(renderLikeABrowser(s.live).text).toContain('MINE');
  });

  it('bound by the first new struct (a pagehide-nulled awareness, or a regenerated client id)', () => {
    const { s, victim, vc } = victimSetup();
    expect(s.deliver(vc, awarenessFrame([{ clientID: 1001, state: null }]))).toBe('applied'); // null never binds
    expect(s.send(vc, victim.edit(s.live, () => textOf(find(victim.doc, 'paragraph')).insert(0, 'first ')))).toBe('applied');
    expectRefused(s, s.conn('attacker'), forge(s, 1001, 'FORGED '), REFUSED('foreign-client'));
  });

  it('accepted: awareness echoes, a reader claiming a writer\'s id, a remount resending a bound peer\'s cached structs', () => {
    const { s, victim, vc } = victimSetup();
    expect(s.deliver(s.conn('reader', true), awarenessFrame([{ clientID: 1001, state: { user: {} } }]))).toBe('applied');
    expect(s.send(vc, victim.edit(s.live, () => textOf(find(victim.doc, 'paragraph')).insert(0, 'v1 ')))).toBe('applied'); // reader did not bind
    expect(s.deliver(s.conn('peer'), awarenessFrame([{ clientID: 1001, state: { user: {} } }]))).toBe('applied'); // an echo
    // A remount: a fresh doc loaded from IndexedDB holds the victim's structs and sends them back (already in live).
    const remount = new Y.Doc();
    Y.applyUpdate(remount, Y.encodeStateAsUpdate(s.live));
    expect(s.send(s.conn('peer'), Y.encodeStateAsUpdate(remount), SYNC.Step2)).toBe('applied');
    expect(s.send(vc, victim.edit(s.live, () => textOf(find(victim.doc, 'paragraph')).insert(0, 'v2 ')))).toBe('applied');
  });

  it('the server\'s own client id is protected', () => {
    const s = setup({ seed: SEED });
    expect(s.send(s.conn('editor'), new RemoteClient(s.live).edit(s.live, (f) => textOf(f.get(0) as Y.XmlElement).insert(0, 'x')))).toBe('applied');
    expectRefused(s, s.conn('attacker'), forge(s, s.live.clientID, 'AS SERVER '), REFUSED('foreign-client'));
  });

  it('two tabs of the same user (two client ids) are accepted', () => {
    const s = setup({ seed: SEED });
    const tab1 = new RemoteClient(s.live, 2001);
    const tab2 = new RemoteClient(s.live, 2002);
    const c1 = s.conn('same-user');
    const c2 = s.conn('same-user');
    expect(s.send(c1, tab1.edit(s.live, () => textOf(find(tab1.doc, 'paragraph')).insert(0, 'a ')))).toBe('applied');
    tab2.sync(s.live);
    expect(s.send(c2, tab2.edit(s.live, () => textOf(find(tab2.doc, 'paragraph')).insert(0, 'b ')))).toBe('applied');
    expect(s.send(c2, Y.encodeStateAsUpdate(tab2.doc), SYNC.Step2)).toBe('applied'); // tab2 resends tab1's structs
  });
});

describe('#781 schema-trap probes', () => {
  it('an unsorted deleteSet (delete p1 AND overwrite the listItem\'s attributes) is still refused', () => {
    const s = setup({
      seedY: (f) => {
        const list = new Y.XmlElement('bulletList');
        const li = new Y.XmlElement('listItem');
        for (const k of ['a', 'b', 'c', 'd']) li.setAttribute(k, 'v');
        const p1 = new Y.XmlElement('paragraph');
        p1.insert(0, [new Y.XmlText('p1')]);
        const nested = new Y.XmlElement('bulletList');
        const nli = new Y.XmlElement('listItem');
        const np = new Y.XmlElement('paragraph');
        np.insert(0, [new Y.XmlText('nested')]);
        nli.insert(0, [np]);
        nested.insert(0, [nli]);
        li.insert(0, [p1, nested]);
        list.insert(0, [li]);
        f.insert(0, [list]);
      },
    });
    const attacker = new RemoteClient(s.live);
    const u = attacker.edit(s.live, () => {
      const li = find(attacker.doc, 'listItem');
      for (const k of ['a', 'b', 'c', 'd']) li.setAttribute(k, 'w');
      li.delete(0, 1);
    });
    expect(renderLikeABrowser(unguarded(s.live, u)).text).not.toContain('nested'); // control
    expectRefused(s, s.conn('attacker'), u, REFUSED('schema'));
  });

  it('a new EMPTY listItem is accepted; filling it with a list first is refused, with a paragraph accepted', () => {
    const s = setup({ seed: { type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] }] } });
    const c = new RemoteClient(s.live);
    const conn = s.conn('editor');
    expect(s.send(conn, c.edit(s.live, () => find(c.doc, 'bulletList').insert(1, [new Y.XmlElement('listItem')])))).toBe('applied');
    const bad = new RemoteClient(s.live).edit(s.live, (_f, d) => find(d, 'listItem', 1).insert(0, [new Y.XmlElement('bulletList')]));
    expect(s.send(s.conn('attacker'), bad)).toBe(REFUSED('schema'));
    const good = new RemoteClient(s.live).edit(s.live, (_f, d) => find(d, 'listItem', 1).insert(0, [new Y.XmlElement('paragraph')]));
    expect(s.send(conn, good)).toBe('applied');
  });

  it('a hashed key of a self-excluding mark beside the plain one (duplicate marks) is refused', () => {
    const s = setup({ seed: SEED });
    const u = new RemoteClient(s.live).edit(s.live, (f) => textOf(f.get(0) as Y.XmlElement).format(0, 3, { 'bold--ABCDEFGH': {}, bold: {} }));
    expectRefused(s, s.conn('attacker'), u, REFUSED('hashed-mark'));
  });
});

describe('#781 deep values and deep trees (stack safety)', () => {
  const formatUpdate = (live: Y.Doc, depth: number) => {
    const placeholder = '{"color":"PLACEHOLDER-781"}';
    const u = new RemoteClient(live).edit(live, (f) => textOf(f.get(0) as Y.XmlElement).format(0, 3, { textStyle: { color: 'PLACEHOLDER-781' } }));
    return spliceVarString(u, placeholder, deepJson(depth));
  };
  it.each([10_000, 100_000])('a format value %i deep (hand-encoded): control breaks every encode; treatment refuses value-depth', (depth) => {
    const s = setup({ seed: SEED });
    const u = formatUpdate(s.live, depth);
    const copy = unguarded(s.live, u);
    expect(() => Y.encodeStateAsUpdate(copy)).toThrow(/Maximum call stack/); // control: no store, no sync step 2, ever
    expectRefused(s, s.conn('attacker'), u, REFUSED('value-depth'));
  });

  it('an attribute value 3000 deep is refused (control: the server would store it at full depth)', () => {
    const s = setup({ seed: SEED });
    let v: unknown = 1;
    for (let i = 0; i < 3000; i++) v = { a: v };
    const u = new RemoteClient(s.live).edit(s.live, (f) => (f.get(0) as Y.XmlElement).setAttribute('textAlign', v as never));
    // Control: fromYdoc hands the recursive walkers (isDeepStrictEqual, stableStringify, structuredClone) a 3000-deep
    // value; whether one overflows depends on the stack left (and on JIT warm-up), which is why the bound is a rule.
    let depth = 0;
    for (let x: any = (TiptapTransformer.fromYdoc(unguarded(s.live, u), 'default') as any).content[0].attrs.textAlign; x && typeof x === 'object'; x = x.a) depth++;
    expect(depth).toBe(3000);
    expectRefused(s, s.conn('attacker'), u, REFUSED('value-depth'));
  });

  it('a Y.Map attribute value is refused', () => {
    const s = setup({ seed: SEED });
    const u = new RemoteClient(s.live).edit(s.live, (f) => {
      const m = new Y.Map();
      (f.get(0) as Y.XmlElement).setAttribute('textAlign', m as never);
      m.set('a', new Y.Map());
    });
    expectRefused(s, s.conn('attacker'), u, REFUSED('content-kind'));
  });

  it('3000 nested elements: control breaks fromYdoc; treatment refuses element-depth', () => {
    const s = setup({ seed: SEED });
    const u = new RemoteClient(s.live).edit(s.live, (f) => {
      let parent: Y.XmlElement = new Y.XmlElement('blockquote');
      f.insert(0, [parent]);
      for (let i = 0; i < 3000; i++) {
        const next = new Y.XmlElement('blockquote');
        parent.insert(0, [next]);
        parent = next;
      }
    });
    expect(() => TiptapTransformer.fromYdoc(unguarded(s.live, u), 'default')).toThrow(/Maximum call stack/);
    expectRefused(s, s.conn('attacker'), u, REFUSED('element-depth'));
  });

  it('a live document that cannot be encoded (a legacy deep value) refuses every frame shadow-unavailable, logged once', () => {
    const seedDoc = prosemirrorJSONToYDoc(schema, SEED, 'default');
    const s = setup({ seed: seedDoc, legacy: formatUpdate(seedDoc, 10_000) });
    expect(() => Y.encodeStateAsUpdate(s.live)).toThrow(/Maximum call stack/);
    const edit = () => new RemoteClient(new Y.Doc()).edit(new Y.Doc(), (f) => f.insert(0, [new Y.XmlElement('paragraph')]));
    expect(s.send(s.conn('a'), edit())).toBe(REFUSED('shadow-unavailable'));
    expect(s.send(s.conn('b'), edit())).toBe(REFUSED('shadow-unavailable'));
    expect(s.logs.filter((l) => l.startsWith('collab_shadow_unavailable'))).toHaveLength(1);
  });
});

describe('#781 the idempotency ledger, other roots and Stateless frames are not client-writable', () => {
  const ledgerSetup = () => {
    const s = setup({ seed: SEED });
    s.live.transact(() => recordWriteKey(s.live, 'victim-key', Date.now()));
    return s;
  };
  it('forging a ledger entry: control flips isDuplicateWriteKey; treatment refuses root', () => {
    const s = ledgerSetup();
    const u = new RemoteClient(s.live).edit(s.live, (_f, d) => d.getMap(WRITE_IDEM_MAP).set('forged-key', 1));
    expect(isDuplicateWriteKey(unguarded(s.live, u), 'forged-key')).toBe(true);
    expectRefused(s, s.conn('attacker'), u, REFUSED('root'));
  });
  it('overwriting and deleting the victim\'s entry: control drops it; treatment refuses root', () => {
    const changes: Array<[boolean, (m: Y.Map<unknown>) => void]> = [
      [false, (m) => m.set('victim-key', 'x')],
      [true, (m) => m.delete('victim-key')],
    ];
    for (const [drops, change] of changes) {
      const s = ledgerSetup();
      const u = new RemoteClient(s.live).edit(s.live, (_f, d) => change(d.getMap(WRITE_IDEM_MAP)));
      if (drops) expect(isDuplicateWriteKey(unguarded(s.live, u), 'victim-key')).toBe(false); // control
      expectRefused(s, s.conn('attacker'), u, REFUSED('root'));
      expect(isDuplicateWriteKey(s.live, 'victim-key')).toBe(true);
    }
  });
  it('a new root is refused', () => {
    const s = setup({ seed: SEED });
    expectRefused(s, s.conn('attacker'), new RemoteClient(s.live).edit(s.live, (_f, d) => d.getMap('evil').set('a', 1)), REFUSED('root'));
  });
  it('client Stateless and BroadcastStateless frames are refused (a forged page.updated)', () => {
    const s = setup({ seed: SEED });
    expect(s.deliver(s.conn('a'), statelessFrame('{"type":"page.updated"}', MSG.Stateless))).toBe(REFUSED('stateless'));
    expect(s.deliver(s.conn('b'), statelessFrame('{"type":"page.updated"}', MSG.BroadcastStateless))).toBe(REFUSED('stateless'));
  });
});

describe('#781 refusal mechanics', () => {
  it('a frame with a missing dependency is unresolved (the client reconnects once)', () => {
    const s = setup({ seed: SEED });
    const c = new RemoteClient(s.live);
    c.edit(s.live, (f) => textOf(f.get(0) as Y.XmlElement).insert(0, 'one '));
    const sv = Y.encodeStateVector(c.doc);
    c.doc.transact(() => textOf(c.fragment.get(0) as Y.XmlElement).insert(0, 'two '));
    const second = Y.encodeStateAsUpdate(c.doc, sv);
    expectRefused(s, s.conn('editor'), second, UNRESOLVED_REASON);
  });

  it('after a refusal every later frame of that connection is refused with the same reason; the socket closes on the budget', () => {
    const s = setup({ seed: SEED });
    const bad = () => new RemoteClient(s.live).edit(s.live, (f) => textOf(f.get(0) as Y.XmlElement).format(0, 2, { evil: {} }));
    const good = new RemoteClient(s.live).edit(s.live, (f) => textOf(f.get(0) as Y.XmlElement).insert(0, 'ok '));
    const first = s.conn('attacker');
    expect(s.send(first, bad())).toBe(REFUSED('unknown-mark'));
    expect(s.send(first, good)).toBe(REFUSED('unknown-mark'));
    const ws = first.webSocket;
    for (let i = 1; i < SOCKET_REFUSAL_BUDGET; i++) {
      expect(ws.close).not.toHaveBeenCalled();
      const again = { ...s.conn('attacker'), webSocket: ws }; // a reconnect on the same socket
      expect(s.send(again, bad())).toBe(REFUSED('unknown-mark'));
    }
    expect(ws.close).toHaveBeenCalledWith(COLLAB_REFUSAL_CODE, REFUSED('unknown-mark'));
  });

  it('logs are rate-limited, structured, and never carry a value', () => {
    const s = setup({ seed: SEED });
    for (let i = 0; i < 100; i++) {
      s.send(s.conn('attacker'), new RemoteClient(s.live).edit(s.live, (f) => textOf(f.get(0) as Y.XmlElement).format(0, 2, { link: { href: { token: 'SECRET-TOKEN-781' } } })));
    }
    const refused = s.logs.filter((l) => l.startsWith('collab_update_refused '));
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.length).toBeLessThan(100);
    expect(JSON.parse(refused[0].slice('collab_update_refused '.length))).toMatchObject({ rule: 'string-attr', userId: 'attacker', mark: 'link' });
    expect(s.logs.join('\n')).not.toContain('SECRET-TOKEN-781');
  });

  it('report mode: the frame applies and the refusal is only logged', () => {
    const s = setup({ seed: SEED, mode: 'report' });
    const u = new RemoteClient(s.live).edit(s.live, (f) => textOf(f.get(0) as Y.XmlElement).format(0, 2, { evil: {} }));
    expect(s.send(s.conn('attacker'), u)).toBe('applied');
    expect(s.logs.some((l) => l.includes('"rule":"unknown-mark"') && l.includes('"mode":"report"'))).toBe(true);
    // The shadow followed the live document: the next honest frame is inspected against the right state.
    expect(s.send(s.conn('editor'), new RemoteClient(s.live).edit(s.live, (f) => f.insert(0, [new Y.XmlElement('paragraph')])))).toBe('applied');
  });

  it('report mode: a frame the shadow cannot apply is not replayed into later rebuilds (the guard stays available)', () => {
    const s = setup({ seed: SEED, mode: 'report' });
    const conn = s.conn('editor');
    expect(s.deliver(conn, syncFrame(new Uint8Array([0xff, 0xff, 0xff, 0x01])))).toBe('applied'); // not applied to live here
    expect(s.send(conn, new RemoteClient(s.live).edit(s.live, (f) => textOf(f.get(0) as Y.XmlElement).insert(0, 'ok ')))).toBe('applied');
    expect(s.guard.shadowOf(s.live)).not.toBeNull();
    expect(s.logs.some((l) => l.startsWith('collab_shadow_unavailable'))).toBe(false);
  });

  it('a mirror failure never stops the live document\'s update events, and the shadow rebuilds', () => {
    const s = setup({ seed: SEED });
    const conn = s.conn('editor');
    expect(s.send(conn, new RemoteClient(s.live).edit(s.live, (f) => textOf(f.get(0) as Y.XmlElement).insert(0, 'a ')))).toBe('applied');
    const shadow = s.guard.shadowOf(s.live)!;
    expect(shadow).toBeTruthy();
    Object.defineProperty(shadow, 'store', { get: () => { throw new Error('mirror boom'); } });
    let events = 0;
    s.live.on('update', () => events++);
    s.live.transact(() => textOf(s.live.getXmlFragment('default').get(0) as Y.XmlElement).insert(0, 'server '));
    s.live.transact(() => textOf(s.live.getXmlFragment('default').get(0) as Y.XmlElement).insert(0, 'again '));
    expect(events).toBe(2);
    expect(s.send(conn, new RemoteClient(s.live).edit(s.live, (f) => textOf(f.get(0) as Y.XmlElement).insert(0, 'b ')))).toBe('applied');
    expect(s.guard.shadowOf(s.live)).not.toBe(shadow);
  });
});

describe('#781 false positives: everything an honest editor sends is accepted', () => {
  it('a full Step2 / SyncReply of a document holding every node and mark', () => {
    for (const type of [MSG.Sync, MSG.SyncReply]) {
      const s = setup();
      const client = prosemirrorJSONToYDoc(schema, ALL_NODES_DOC, 'default');
      expect(s.send(s.conn('editor'), Y.encodeStateAsUpdate(client), SYNC.Step2, type)).toBe('applied');
      expect(contentOf(s.live)).toEqual(contentOf(client));
    }
  });

  it('a y-tiptap edit stream (typing, marks, lists, tables, columns, details, comments, inline nodes, deletes)', () => {
    const s = setup({ seed: ALL_NODES_DOC });
    const client = new RemoteClient(s.live, 4242);
    const conn = s.conn('editor');
    const sent: string[] = [];
    client.doc.on('update', (u: Uint8Array) => sent.push(s.send(conn, u)));
    const { meta } = initProseMirrorDoc(client.fragment, schema);
    let json: any = structuredClone(ALL_NODES_DOC);
    const edit = (change: (d: any) => void) => {
      json = structuredClone(json);
      change(json);
      const node = PMNode.fromJSON(schema, json);
      node.check(); // the edit itself is valid
      client.doc.transact(() => updateYFragment(client.doc, client.fragment, node, meta as never));
    };
    edit((d) => d.content[1].content[0].text = 'plain typed ');
    edit((d) => d.content[1].content.splice(1, 0, { type: 'text', text: 'B', marks: [{ type: 'bold' }, { type: 'italic' }] }));
    edit((d) => d.content.push({ type: 'paragraph', content: [{ type: 'text', text: 'new para' }] }));
    edit((d) => d.content.push({ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'li' }] }] }] }));
    edit((d) => d.content[d.content.length - 1].content.push({ type: 'listItem', content: [{ type: 'paragraph' }] }));
    edit((d) => d.content[4].content[0].content[1].content[0].content.push({ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'deeper' }] }] }] }));
    const tableAt = json.content.findIndex((n: any) => n.type === 'table');
    edit((d) => d.content[tableAt].content.push({ type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph' }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'r3' }] }] }] }));
    edit((d) => d.content[tableAt].content[1].content[0].attrs = { backgroundColor: '#eee', backgroundColorName: 'gray' });
    const columnsAt = json.content.findIndex((n: any) => n.type === 'columns');
    edit((d) => d.content[columnsAt].content.push({ type: 'column', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'col3' }] }] }));
    const detailsAt = json.content.findIndex((n: any) => n.type === 'details');
    edit((d) => d.content[detailsAt].attrs = { open: false });
    edit((d) => d.content[detailsAt].content[1].content.push({ type: 'paragraph', content: [{ type: 'text', text: 'more' }] }));
    edit((d) => d.content[1].content[0].marks = [{ type: 'comment', attrs: { commentId: 'c2', resolved: false } }]);
    edit((d) => d.content[1].content.push({ type: 'mention', attrs: { id: 'm2', label: 'Bob', entityType: 'user', entityId: 'u2' } }, { type: 'mathInline', attrs: { text: 'y' } }, { type: 'status', attrs: { text: 'WIP', color: 'blue' } }));
    edit((d) => d.content[0].attrs = { level: 2 });
    const imageAt = json.content.findIndex((n: any) => n.type === 'image');
    edit((d) => d.content[imageAt].attrs = { src: '/api/files/a9/new.png', attachmentId: 'a9', alt: undefined });
    edit((d) => d.content.splice(3, 1));
    edit((d) => d.content[1].content.splice(2, 3));
    edit((d) => d.content.splice(0, 2));
    expect(sent.length).toBeGreaterThan(10);
    expect(sent.filter((r) => r !== 'applied')).toEqual([]);
    expect(contentOf(s.live)).toEqual(contentOf(client.doc));
    expect(renderLikeABrowser(s.live)).toMatchObject({ deleted: false, threw: false });
  });

  it('offline create-then-delete (GC structs), an attribute set twice (ContentDeleted), undefined attributes', () => {
    const s = setup({ seed: SEED });
    const c = new RemoteClient(s.live);
    const sv = Y.encodeStateVector(s.live);
    c.doc.transact(() => {
      const extra = new Y.XmlElement('paragraph');
      c.fragment.insert(1, [extra]);
      extra.insert(0, [new Y.XmlText('gone')]);
    });
    c.doc.transact(() => c.fragment.delete(1, 1));
    const p = c.fragment.get(0) as Y.XmlElement;
    c.doc.transact(() => p.setAttribute('textAlign', 'left'));
    c.doc.transact(() => p.setAttribute('textAlign', 'center'));
    c.doc.transact(() => p.setAttribute('indent', undefined as never));
    expect(s.send(s.conn('editor'), Y.encodeStateAsUpdate(c.doc, sv), SYNC.Step2)).toBe('applied');
    expect((contentOf(s.live) as any).content[0].attrs.textAlign).toBe('center');
  });

  it('concurrent code and bold over the same text (an excluding pair) are both accepted, as y-tiptap deletes nothing', () => {
    const s = setup({ seed: SEED });
    const one = new RemoteClient(s.live);
    const two = new RemoteClient(s.live);
    const u1 = one.edit(s.live, (f) => textOf(f.get(0) as Y.XmlElement).format(0, 6, { code: {} }));
    const u2 = two.edit(s.live, (f) => textOf(f.get(0) as Y.XmlElement).format(0, 6, { bold: {} }));
    expect(s.send(s.conn('one'), u1)).toBe('applied');
    expect(s.send(s.conn('two'), u2)).toBe('applied');
    expect(renderLikeABrowser(s.live)).toMatchObject({ deleted: false, threw: false });
  });

  it('typing after a bold run (Yjs writes null formats to end the mark)', () => {
    const s = setup({ seed: SEED });
    const c = new RemoteClient(s.live);
    const conn = s.conn('editor');
    expect(s.send(conn, c.edit(s.live, (f) => textOf(f.get(0) as Y.XmlElement).format(0, 6, { bold: {} })))).toBe('applied');
    expect(s.send(conn, c.edit(s.live, (f) => textOf(f.get(0) as Y.XmlElement).insert(3, 'x', {})))).toBe('applied');
  });
});

describe('#781 the Yjs internals the guard reads (re-check on a Yjs 14 / Hocuspocus 4 bump)', () => {
  it('inside transact(local=false) after applyUpdate: beforeState, new structs from findIndexSS, an unsorted deleteSet', () => {
    const live = new Y.Doc();
    const p = new Y.XmlElement('paragraph');
    live.getXmlFragment('default').insert(0, [p]);
    const c = new RemoteClient(live);
    const u = c.edit(live, (f) => {
      (f.get(0) as Y.XmlElement).setAttribute('a', 1 as never);
      f.insert(1, [new Y.XmlElement('paragraph')]);
      f.delete(0, 1);
    });
    Y.transact(live, (tr) => {
      Y.applyUpdate(live, u);
      expect(tr.local).toBe(false);
      expect(tr.afterState.size).toBe(0); // filled only in cleanup: compute it from the store
      const structs = live.store.clients.get(c.doc.clientID)!;
      const fresh = structs.slice(Y.findIndexSS(structs, tr.beforeState.get(c.doc.clientID) ?? 0));
      expect(fresh.length).toBeGreaterThan(0);
      let deleted = 0;
      Y.iterateDeletedStructs(tr, tr.deleteSet, () => deleted++);
      expect(deleted).toBeGreaterThan(0);
    }, 'probe', false);
  });

  it('pending structs and deletes are V2 updates the guard can decode', () => {
    const src = new Y.Doc();
    src.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]);
    const sv = Y.encodeStateVector(src);
    src.getXmlFragment('default').insert(1, [new Y.XmlElement('paragraph')]);
    src.getXmlFragment('default').delete(0, 1);
    const d = new Y.Doc();
    Y.applyUpdate(d, Y.encodeStateAsUpdate(src, sv));
    expect(Y.decodeUpdateV2(d.store.pendingStructs!.update).structs.length).toBeGreaterThan(0);
    expect(Y.decodeUpdateV2(d.store.pendingDs!).ds.clients.size).toBe(1);
  });
});
