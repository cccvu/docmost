import * as Y from 'yjs';
import { initProseMirrorDoc, prosemirrorJSONToYDoc, updateYFragment } from '@tiptap/y-tiptap';
import { Node as PMNode } from '@tiptap/pm/model';
import { TableMap } from '@tiptap/pm/tables';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { MessageType } from '@hocuspocus/server';
import * as encoding from 'lib0/encoding';
import { htmlToJson, jsonToHtml } from '../../collaboration/collaboration.util';
import { serverSchema } from '../page-write/prelim-content';
import { isDuplicateWriteKey, recordWriteKey, WRITE_IDEM_MAP } from '../page-write/write-idem';
import {
  ALL_NODES_DOC,
  authFrame,
  awarenessFrame,
  contentOf,
  deepJson,
  DOC_NAME,
  MSG,
  RemoteClient,
  renderLikeABrowser,
  spliceVarString,
  statelessFrame,
  step1Frame,
  SYNC,
  syncFrame,
  typedFrame,
} from './collab-ingress.testkit';
import { INT_ATTRS, STRING_ATTRS } from './content-rules';
import { COLLAB_CONNECTIONS_PER_USER } from './limits';
import { SocketLimitLog } from './socket-limit-log';
import {
  AWARENESS_BINDS_PER_USER,
  AWARENESS_NEW_IDS_BURST,
  AWARENESS_NEW_IDS_REFILL_MS,
  COLLAB_TRY_LATER_CODE,
  AWARENESS_STATE_MAX_BYTES,
  COLLAB_REFUSAL_CODE,
  CollabUpdateGuard,
  SOCKET_REFUSAL_BUDGET,
  SYNC_BURST,
  SYNC_REFILL_MS,
  TRY_LATER_REASON,
  USER_DOC_BUDGETS_MAX,
  USER_SYNC_BURST,
  USER_SYNC_REFILL_MS,
  UNRESOLVED_REASON,
  type CollabGuardMode,
} from './update-guard';

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
/** #790: an exhausted (user, document) budget: the socket closed 1013, never a 4422 refusal. */
const TRY_LATER = 'try-later';

type Conn = { readOnly: boolean; webSocket: { close: jest.Mock }; context: { user: { id: string } } };

function setup(opts: { mode?: CollabGuardMode; seed?: unknown | Y.Doc; seedY?: (f: Y.XmlFragment, d: Y.Doc) => void; legacy?: Uint8Array; now?: () => number } = {}) {
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
  const limitLogs: string[] = [];
  const guard = new CollabUpdateGuard({
    mode: opts.mode ?? 'enforce',
    logger: { warn: (m: string) => logs.push(m) },
    limitLog: new SocketLimitLog({ warn: (m: string) => limitLogs.push(m) }),
    now: opts.now,
  });
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
      if (err?.code === COLLAB_TRY_LATER_CODE) {
        expect(err).toEqual({ code: COLLAB_TRY_LATER_CODE, reason: TRY_LATER_REASON });
        // the socket is closed FIRST, so Hocuspocus's document CLOSE (sent after the throw) never reaches the editor
        expect(c.webSocket.close).toHaveBeenLastCalledWith(COLLAB_TRY_LATER_CODE, TRY_LATER_REASON);
        return TRY_LATER;
      }
      expect(err).toEqual({ code: COLLAB_REFUSAL_CODE, reason: expect.any(String) });
      return err.reason;
    }
    if (apply) Y.applyUpdate(live, apply, c);
    return 'applied';
  };
  const send = (c: Conn, update: Uint8Array, subtype: number = SYNC.Update, type: number = MSG.Sync) =>
    deliver(c, syncFrame(update, subtype, type), update);
  const snapshot = () => ({ live: Y.encodeStateAsUpdate(live), peer: Y.encodeStateAsUpdate(peer) });
  return { live, guard, peer, logs, limitLogs, conn, send, deliver, snapshot };
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

describe('#781 review: null where the default is a string, table spans, and a __proto__ attribute', () => {
  it('a null STRING_ATTRS value is refused only where the schema default is not null (y-tiptap never writes null)', () => {
    let refused = 0;
    for (const entry of [...STRING_ATTRS].filter((e) => e.startsWith('node '))) {
      const [type, attr] = entry.slice('node '.length).split('.');
      const def = (schema.nodes[type].spec.attrs as Record<string, { default?: unknown }>)[attr]?.default;
      const s = setup({ seed: ALL_NODES_DOC });
      const c = new RemoteClient(s.live);
      const u = c.edit(s.live, () => find(c.doc, type).setAttribute(attr, null as never));
      if (def === null || def === undefined) {
        expect(s.send(s.conn('editor'), u)).toBe('applied');
      } else {
        expectRefused(s, s.conn('attacker'), u, REFUSED('string-attr'));
        refused++;
      }
    }
    expect(refused).toBeGreaterThanOrEqual(10); // math text, media src, embed provider, …
  });

  it('a math node whose text is null: control crashes every viewer (text.trim()); treatment refuses', () => {
    const s = setup({ seed: ALL_NODES_DOC });
    const c = new RemoteClient(s.live);
    const u = c.edit(s.live, () => find(c.doc, 'mathBlock').setAttribute('text', null as never));
    const control = unguarded(s.live, u);
    expect(initProseMirrorDoc(control.getXmlFragment('default'), schema).doc.firstChild).toBeDefined();
    let mathText: unknown = 'unset';
    initProseMirrorDoc(control.getXmlFragment('default'), schema).doc.descendants((n) => {
      if (n.type.name === 'mathBlock') mathText = n.attrs.text;
    });
    expect(mathText).toBeNull(); // the client view then calls node.attrs.text.trim()
    expectRefused(s, s.conn('attacker'), u, REFUSED('string-attr'));
  });

  it('a table colspan of 1e9: control renders one column per unit for every viewer; treatment refuses number-attr', () => {
    expect([...INT_ATTRS.keys()].sort()).toEqual(['node tableCell.colspan', 'node tableCell.rowspan', 'node tableHeader.colspan', 'node tableHeader.rowspan']);
    for (const [entry, [, max]] of INT_ATTRS) {
      const [type, attr] = entry.slice('node '.length).split('.');
      const s = setup({ seed: ALL_NODES_DOC });
      const edit = (value: unknown) => {
        const c = new RemoteClient(s.live);
        return c.edit(s.live, () => find(c.doc, type).setAttribute(attr, value as never));
      };
      const huge = edit(1e9);
      expect((contentOf(unguarded(s.live, huge)) as any).content.find((n: any) => n.type === 'table')).toBeDefined(); // control stores it
      for (const bad of [1e9, max + 1, 0, -1, 1.5, '5', null, { n: 1 }]) expectRefused(s, s.conn('attacker'), edit(bad), REFUSED('number-attr'));
      expect(s.send(s.conn('honest'), edit(2))).toBe('applied');
    }
  });

  it('widening a table past 1000 columns through one cell span: control maps 1001 columns; treatment refuses table-size', () => {
    const s = setup({ seed: ALL_NODES_DOC });
    const c = new RemoteClient(s.live);
    const u = c.edit(s.live, () => find(c.doc, 'tableCell').setAttribute('colspan', 1000 as never)); // in range on its own
    let width = 0;
    initProseMirrorDoc(unguarded(s.live, u).getXmlFragment('default'), schema).doc.descendants((n) => {
      if (n.type.name === 'table') width = TableMap.get(n).width;
    });
    expect(width).toBe(1001); // control
    expectRefused(s, s.conn('attacker'), u, REFUSED('table-size'));
    const honest = new RemoteClient(s.live);
    expect(s.send(s.conn('honest'), honest.edit(s.live, () => find(honest.doc, 'tableCell').setAttribute('colspan', 2 as never)))).toBe('applied');
  });

  it('a new table of in-range cells adding up past the bound is refused; an honest paste of odd HTML spans is accepted', () => {
    const s = setup({ seed: SEED });
    const tableOf = (json: unknown) => prosemirrorJSONToYDoc(schema, json, 'default').getXmlFragment('default').get(0) as Y.XmlElement;
    const insert = (json: unknown) => {
      const c = new RemoteClient(s.live);
      return c.edit(s.live, (f) => f.insert(1, [tableOf(json).clone()]));
    };
    const cellJ = (colspan: number) => ({ type: 'tableCell', attrs: { colspan }, content: [{ type: 'paragraph' }] });
    const wide = { type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [cellJ(600), cellJ(600)] }] }] };
    expectRefused(s, s.conn('attacker'), insert(wide), REFUSED('table-size'));
    // What a browser's paste parser makes of colspan="100%", "", " 2", rowspan="0" (the editor-ext span clamp).
    const pasted = htmlToJson('<table><tr><td colspan="100%">a</td><td colspan="">b</td><td colspan=" 2" rowspan="0">c</td></tr></table>');
    expect(s.send(s.conn('honest'), insert(pasted))).toBe('applied');
  });

  it('a legacy table already past the bound is reported, and editing its cells is not refused for it', () => {
    const legacy = new Y.Doc();
    legacy.transact(() => {
      const row = new Y.XmlElement('tableRow');
      for (const span of [800, 800]) {
        const cellEl = new Y.XmlElement('tableCell');
        cellEl.setAttribute('colspan', span as never);
        const para = new Y.XmlElement('paragraph');
        para.insert(0, [new Y.XmlText('x')]);
        cellEl.insert(0, [para]);
        row.insert(row.length, [cellEl]);
      }
      const tableEl = new Y.XmlElement('table');
      tableEl.insert(0, [row]);
      legacy.getXmlFragment('default').insert(0, [tableEl]);
    });
    const s = setup({ legacy: Y.encodeStateAsUpdate(legacy) });
    const c = new RemoteClient(s.live);
    const u = c.edit(s.live, () => find(c.doc, 'tableCell').setAttribute('backgroundColor', '#fff' as never));
    expect(s.send(s.conn('editor'), u)).toBe('applied');
    expect(s.logs.some((l) => l.startsWith('COLLAB_STORED_CONTENT_INVALID') && l.includes('table-size'))).toBe(true);
  });

  it('an element attribute named __proto__ is refused by the stateless pre-pass, before any shadow exists', () => {
    const s = setup({ seed: ALL_NODES_DOC });
    const c = new RemoteClient(s.live);
    // Yjs builds getAttributes() by assignment, so this would re-prototype the image's attrs with a non-string src.
    const u = c.edit(s.live, () => find(c.doc, 'image').setAttribute('__proto__', { src: { evil: 1 } } as never));
    expectRefused(s, s.conn('attacker'), u, REFUSED('attr-kind'));
    expect(s.guard.shadowOf(s.live)).toBeNull(); // refused in the pre-pass: the shadow step never ran
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
    expect(s.logs.some((l) => l.startsWith('COLLAB_STORED_CONTENT_INVALID'))).toBe(true);
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
  it.each([
    ['a listItem whose first paragraph is invalid, followed by a nested list (y-tiptap then deletes the listItem too)', 'listItem'],
    ['a details whose summary is invalid (y-tiptap then deletes the details too)', 'details'],
  ])('legacy: %s — every browser\'s cascade of deletes is accepted on open', (_name, shape) => {
    const legacyDoc = new Y.Doc();
    legacyDoc.transact(() => {
      const el = (name: string, ...children: Array<Y.XmlElement | Y.XmlText>) => {
        const e = new Y.XmlElement(name);
        e.insert(0, children);
        return e;
      };
      const para = (text: string) => el('paragraph', new Y.XmlText(text));
      // Invalid before the guard existed: a paragraph holding a block (y-tiptap deletes it), and a summary holding one.
      const bad = shape === 'listItem' ? el('paragraph', para('inner')) : el('detailsSummary', para('inner'));
      const block =
        shape === 'listItem'
          ? el('bulletList', el('listItem', bad, el('bulletList', el('listItem', para('nested')))), el('listItem', para('sibling')))
          : el('details', bad, el('detailsContent', para('hidden')));
      legacyDoc.getXmlFragment('default').insert(0, [block, para('victim text')]);
    });
    const s = setup({ legacy: Y.encodeStateAsUpdate(legacyDoc) });
    // A browser opens the page: y-tiptap deletes what it cannot build, one transaction per element, each sent as a frame.
    const browser = new Y.Doc();
    Y.applyUpdate(browser, Y.encodeStateAsUpdate(s.live));
    const sent: Uint8Array[] = [];
    browser.on('update', (u: Uint8Array) => sent.push(u));
    initProseMirrorDoc(browser.getXmlFragment('default'), schema);
    expect(sent.length).toBeGreaterThanOrEqual(2); // the invalid element, then its parent: a cascade
    const editor = s.conn('opener');
    for (const u of sent) expect(s.send(editor, u)).toBe('applied');
    expect(renderLikeABrowser(s.live).text).toContain('victim text');
  });

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
    const meta = new Map<number, { clock: number }>();
    (s.live as unknown as { awareness: unknown }).awareness = { meta };
    expect(s.deliver(s.conn('reader', true), awarenessFrame([{ clientID: 1001, state: { user: {} } }]))).toBe('applied');
    meta.set(1001, { clock: 1 }); // Hocuspocus applied and relayed it
    expect(s.send(vc, victim.edit(s.live, () => textOf(find(victim.doc, 'paragraph')).insert(0, 'v1 ')))).toBe('applied'); // reader did not bind
    expect(s.deliver(s.conn('peer'), awarenessFrame([{ clientID: 1001, state: { user: {} } }]))).toBe('applied'); // an echo of what was relayed
    // A remount: a fresh doc loaded from IndexedDB holds the victim's structs and sends them back (already in live).
    const remount = new Y.Doc();
    Y.applyUpdate(remount, Y.encodeStateAsUpdate(s.live));
    expect(s.send(s.conn('peer'), Y.encodeStateAsUpdate(remount), SYNC.Step2)).toBe('applied');
    expect(s.send(vc, victim.edit(s.live, () => textOf(find(victim.doc, 'paragraph')).insert(0, 'v2 ')))).toBe('applied');
  });

  it('a writer echoing a reader\'s awareness does not bind the reader\'s id: the reader, once promoted, edits under it', () => {
    const s = setup({ seed: SEED });
    // Hocuspocus's Document applies every awareness frame (a reader's too) to its awareness; stand in for its meta.
    const meta = new Map<number, { clock: number }>();
    (s.live as unknown as { awareness: unknown }).awareness = { meta };
    const reader = new RemoteClient(s.live, 3003);
    expect(s.deliver(s.conn('reader', true), awarenessFrame([{ clientID: 3003, clock: 4, state: { user: { name: 'R' } } }]))).toBe('applied');
    meta.set(3003, { clock: 4 }); // what Hocuspocus then applies and relays
    // Every writer's provider sends the relayed state back: the same clock, so not an announcement of its own.
    expect(s.deliver(s.conn('writer'), awarenessFrame([{ clientID: 3003, clock: 4, state: { user: { name: 'R' } } }]))).toBe('applied');
    expect(s.deliver(s.conn('writer'), awarenessFrame([{ clientID: 3003, clock: 3, state: { user: { name: 'R' } } }]))).toBe('applied');
    // The reader is granted edit and re-authenticates with the same Y.Doc: its first edit is accepted and binds the id.
    const promoted = s.conn('reader');
    expect(s.send(promoted, reader.edit(s.live, () => textOf(find(reader.doc, 'paragraph')).insert(0, 'now a writer ')))).toBe('applied');
    expectRefused(s, s.conn('writer'), forge(s, 3003, 'FORGED '), REFUSED('foreign-client'));
  });

  it('a writer announcing a state at a NEWER clock than the server holds still binds (its own id, or an unbound one)', () => {
    const s = setup({ seed: SEED });
    const meta = new Map<number, { clock: number }>([[1001, { clock: 1 }]]);
    (s.live as unknown as { awareness: unknown }).awareness = { meta };
    expect(s.deliver(s.conn('victim'), awarenessFrame([{ clientID: 1001, clock: 2, state: { user: { name: 'V' } } }]))).toBe('applied');
    expectRefused(s, s.conn('attacker'), forge(s, 1001, 'FORGED '), REFUSED('foreign-client'));
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
    expect(s.logs.filter((l) => l.startsWith('COLLAB_SHADOW_UNAVAILABLE'))).toHaveLength(1);
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

  it('a frame accepted but never applied leaves the shadow ahead of live: it is rebuilt before a later frame reuses those clocks', async () => {
    const s = setup({ seed: SEED });
    const c = s.conn('editor');
    // Accepted by the guard, then never applied (e.g. #501's revalidator made the connection read-only in flight).
    const first = new RemoteClient(s.live, 4242).edit(s.live, (f) => f.insert(0, [new Y.XmlElement('paragraph')]));
    expect(s.deliver(c, syncFrame(first))).toBe('applied');
    expect(Y.getState(s.live.store, 4242)).toBe(0);
    await new Promise((r) => setImmediate(r));
    // The same client id and clocks, now carrying a listItem at the root (y-tiptap deletes it on every peer).
    const reuse = new RemoteClient(s.live, 4242).edit(s.live, (f) => f.insert(0, [new Y.XmlElement('listItem')]));
    expect(renderLikeABrowser(unguarded(s.live, reuse)).deleted).toBe(true); // control
    expectRefused(s, c, reuse, REFUSED('schema'));
  });

  it('logs are rate-limited, structured, and never carry a value', () => {
    const s = setup({ seed: SEED });
    for (let i = 0; i < 100; i++) {
      s.send(s.conn('attacker'), new RemoteClient(s.live).edit(s.live, (f) => textOf(f.get(0) as Y.XmlElement).format(0, 2, { link: { href: { token: 'SECRET-TOKEN-781' } } })));
    }
    const refused = s.logs.filter((l) => l.startsWith('COLLAB_UPDATE_REFUSED '));
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.length).toBeLessThan(100);
    expect(JSON.parse(refused[0].slice('COLLAB_UPDATE_REFUSED '.length))).toMatchObject({ rule: 'string-attr', userId: 'attacker', mark: 'link' });
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
    expect(s.logs.some((l) => l.startsWith('COLLAB_SHADOW_UNAVAILABLE'))).toBe(false);
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

describe('#790 frame bounds: the sync budget, per (user, document), across connections', () => {
  const clocked = () => {
    let t = 1_000_000;
    const s = setup({ seed: SEED, now: () => t });
    return { s, advance: (ms: number) => (t += ms) };
  };

  it(`a user's SyncStep1s: ${SYNC_BURST} pass across reconnects, the next closes the socket 1013 (Sync and SyncReply alike)`, () => {
    for (const type of [MSG.Sync, MSG.SyncReply]) {
      const { s } = clocked();
      const frame = type === MSG.Sync ? step1Frame(s.live) : syncFrame(Y.encodeStateVector(s.live), SYNC.Step1, MSG.SyncReply);
      // one Step1 per connection: a reconnect loop gets no fresh budget
      for (let i = 0; i < SYNC_BURST; i++) expect(s.deliver(s.conn('writer'), frame)).toBe('applied');
      const last = s.conn('writer');
      expect(s.deliver(last, frame)).toBe(TRY_LATER);
      expect(s.limitLogs).toEqual(['COLLAB_SOCKET_LIMIT {"limit":"user_sync_budget","userId":"writer"}']);
      expect(s.deliver(s.conn('other-user'), frame)).toBe('applied'); // per user
      expect(s.logs.filter((l) => l.includes('COLLAB_UPDATE_REFUSED'))).toEqual([]); // never a 4422 refusal
    }
  });

  /** A Step1 for another page, through the same guard: 'applied' or TRY_LATER. */
  const onPage = (s: ReturnType<typeof setup>, user: string, n: number) => {
    const doc = new Y.Doc() as Y.Doc & { name: string };
    doc.name = `page.00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const c = s.conn(user);
    try {
      s.guard.check({ connection: c, document: doc, update: step1Frame(doc), context: c.context });
      return 'applied';
    } catch (err: any) {
      expect(err).toEqual({ code: COLLAB_TRY_LATER_CODE, reason: TRY_LATER_REASON });
      return TRY_LATER;
    }
  };

  it(`a new page buys no new burst: ${USER_SYNC_BURST} Step1s per user across all pages, then one per ${USER_SYNC_REFILL_MS} ms`, () => {
    const { s, advance } = clocked();
    for (let n = 1; n <= USER_SYNC_BURST; n++) expect(onPage(s, 'reader', n)).toBe('applied'); // one Step1 on each of 64 pages
    expect(onPage(s, 'reader', 1000)).toBe(TRY_LATER); // a fresh page, but the user's budget is spent
    expect(onPage(s, 'someone-else', 1000)).toBe('applied');
    advance(USER_SYNC_REFILL_MS);
    expect(onPage(s, 'reader', 1001)).toBe('applied');
    expect(onPage(s, 'reader', 1002)).toBe(TRY_LATER);
  });

  it('the per-page budget still binds within the user budget: one page cannot spend more than its own burst', () => {
    const { s, advance } = clocked();
    for (let i = 0; i < SYNC_BURST; i++) expect(s.deliver(s.conn('writer'), step1Frame(s.live))).toBe('applied');
    advance(10 * USER_SYNC_REFILL_MS); // the user budget refills 10, the page budget 2
    expect(s.deliver(s.conn('writer'), step1Frame(s.live))).toBe('applied');
    expect(s.deliver(s.conn('writer'), step1Frame(s.live))).toBe('applied');
    expect(s.deliver(s.conn('writer'), step1Frame(s.live))).toBe(TRY_LATER); // the page is spent, the user is not
    expect(onPage(s, 'writer', 7)).toBe('applied'); // so another page still opens
  });

  it(`refills one per ${SYNC_REFILL_MS} ms, never above the burst`, () => {
    const { s, advance } = clocked();
    advance(10 * SYNC_REFILL_MS); // idle before the first frame: still only the burst
    for (let i = 0; i < SYNC_BURST; i++) expect(s.deliver(s.conn('writer'), step1Frame(s.live))).toBe('applied');
    advance(SYNC_REFILL_MS - 1);
    expect(s.deliver(s.conn('writer'), step1Frame(s.live))).toBe(TRY_LATER);
    advance(1);
    expect(s.deliver(s.conn('writer'), step1Frame(s.live))).toBe('applied'); // one back after exactly SYNC_REFILL_MS
    expect(s.deliver(s.conn('writer'), step1Frame(s.live))).toBe(TRY_LATER);
    advance(100 * SYNC_REFILL_MS);
    for (let i = 0; i < SYNC_BURST; i++) expect(s.deliver(s.conn('writer'), step1Frame(s.live))).toBe('applied'); // capped
    expect(s.deliver(s.conn('writer'), step1Frame(s.live))).toBe(TRY_LATER);
  });

  it(`every tab of the per-user connection cap (${COLLAB_CONNECTIONS_PER_USER}) reconnecting at once after a deploy passes, readers too`, () => {
    for (const readOnly of [false, true]) {
      const { s } = clocked();
      for (let i = 0; i < COLLAB_CONNECTIONS_PER_USER; i++) {
        const c = s.conn('many-tabs', readOnly);
        expect(s.deliver(c, step1Frame(s.live))).toBe('applied');
        if (readOnly) expect(s.deliver(c, syncFrame(Y.encodeStateAsUpdate(s.live), SYNC.Step2))).toBe('applied');
      }
      expect(s.limitLogs).toEqual([]);
    }
  });

  it("a reader's Step2 is counted (4.7.1 snapshots the whole document for it); its Update is not (an O(1) nack)", () => {
    const { s } = clocked();
    const reader = s.conn('reader', true);
    const update = new RemoteClient(s.live).edit(s.live, (f) => textOf(f.get(0) as Y.XmlElement).insert(0, 'x '));
    expect(s.deliver(reader, step1Frame(s.live))).toBe('applied');
    for (let i = 0; i < 200; i++) expect(s.deliver(reader, syncFrame(update, SYNC.Update))).toBe('applied'); // y-tiptap's per-element deletes on a legacy page
    for (let i = 1; i < SYNC_BURST; i++) expect(s.deliver(reader, syncFrame(update, SYNC.Step2))).toBe('applied');
    expect(s.deliver(reader, syncFrame(update, SYNC.Step2))).toBe(TRY_LATER);
  });

  it("an honest open passes: one Step1, a Step2, awareness, then a stream of updates (a writer's Step2 and Updates are not counted)", () => {
    const { s } = clocked();
    const c = s.conn('writer');
    const client = new RemoteClient(s.live, 4242);
    expect(s.deliver(c, step1Frame(client.doc))).toBe('applied');
    expect(s.send(c, client.edit(s.live, (f) => textOf(f.get(0) as Y.XmlElement).insert(0, 'offline ')), SYNC.Step2)).toBe('applied');
    expect(s.deliver(c, awarenessFrame([{ clientID: 4242, state: { user: { name: 'W' } } }]))).toBe('applied');
    for (let i = 0; i < 3 * SYNC_BURST; i++) {
      expect(s.send(c, client.edit(s.live, (f) => textOf(f.get(0) as Y.XmlElement).insert(0, `${i} `)))).toBe('applied');
    }
    const reader = s.conn('reader', true);
    expect(s.deliver(reader, step1Frame(s.live))).toBe('applied');
    expect(s.deliver(reader, syncFrame(Y.encodeStateAsUpdate(s.live), SYNC.Step2))).toBe('applied');
  });

  it('report mode logs an exhausted budget and closes nothing', () => {
    const s = setup({ seed: SEED, mode: 'report', now: () => 1 });
    for (let i = 0; i < SYNC_BURST + 3; i++) expect(s.deliver(s.conn('writer'), step1Frame(s.live))).toBe('applied');
    expect(s.limitLogs).toHaveLength(3);
  });

  it(`the budgets map is bounded (${USER_DOC_BUDGETS_MAX}); the least recently used is dropped`, () => {
    const s = setup({ seed: SEED, now: () => 1 });
    for (let i = 0; i < SYNC_BURST; i++) s.deliver(s.conn('kept'), step1Frame(s.live));
    for (let i = 0; i < USER_DOC_BUDGETS_MAX + 50; i++) s.deliver(s.conn(`u${i}`), step1Frame(s.live));
    expect(s.guard.budgetCount()).toBe(USER_DOC_BUDGETS_MAX);
    // 'kept' was the least recently used, so it is gone, and comes back with a fresh budget
    expect(s.deliver(s.conn('kept'), step1Frame(s.live))).toBe('applied');
  });
});

describe('#790 frame bounds: awareness, for writers and readers', () => {
  const big = 'x'.repeat(AWARENESS_STATE_MAX_BYTES);
  /** A state whose JSON text is exactly `bytes` UTF-8 bytes. */
  const stateOf = (bytes: number) => ({ json: JSON.stringify({ n: big.slice(0, bytes - 8) }) });

  it.each([['writer', false], ['reader', true]] as const)(
    'a %s: a state over AWARENESS_STATE_MAX_BYTES is refused before anything parses it; one at the bound passes',
    (_who, readOnly) => {
      const s = setup({ seed: SEED });
      expect(stateOf(AWARENESS_STATE_MAX_BYTES).json.length).toBe(AWARENESS_STATE_MAX_BYTES);
      expect(s.deliver(s.conn('a', readOnly), awarenessFrame([{ clientID: 11, state: null, ...stateOf(AWARENESS_STATE_MAX_BYTES) }]))).toBe('applied');
      const parse = jest.spyOn(JSON, 'parse');
      try {
        // Not even valid JSON past the bound: a guard that parsed it first would throw, not refuse.
        const json = '{'.repeat(AWARENESS_STATE_MAX_BYTES + 1);
        expect(s.deliver(s.conn('b', readOnly), awarenessFrame([{ clientID: 12, state: null, json }]))).toBe(REFUSED('awareness'));
        // Bytes, not UTF-16 units: 4100 two-byte characters are 8200 bytes.
        expect(s.deliver(s.conn('c', readOnly), awarenessFrame([{ clientID: 13, state: { n: 'é'.repeat(4100) } }]))).toBe(REFUSED('awareness'));
        expect(parse.mock.calls.filter(([text]) => typeof text === 'string' && text.length > 4000)).toEqual([]);
      } finally {
        parse.mockRestore();
      }
      expect(s.guard.bindingCount(s.live)).toBe(readOnly ? 0 : 2); // a reader binds nothing; a writer: live's own id + its state
    },
  );

  it.each([['writer', false], ['reader', true]] as const)(
    `a %s: ${AWARENESS_NEW_IDS_BURST} client ids new to the document per (user, document), across reconnects; past it the socket closes 1013`,
    (_who, readOnly) => {
      let t = 1_000_000;
      const s = setup({ seed: SEED, now: () => t });
      const ids = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ clientID: from + i, state: {} }));
      const c = s.conn('a', readOnly);
      expect(s.deliver(c, awarenessFrame(ids(100, AWARENESS_NEW_IDS_BURST / 2)))).toBe('applied');
      expect(s.deliver(c, awarenessFrame(ids(100, AWARENESS_NEW_IDS_BURST / 2)))).toBe('applied'); // the same ids again: paid for
      // a reconnect does not refill it
      expect(s.deliver(s.conn('a', readOnly), awarenessFrame(ids(500, AWARENESS_NEW_IDS_BURST / 2)))).toBe('applied');
      expect(s.deliver(s.conn('a', readOnly), awarenessFrame(ids(600, 1)))).toBe(TRY_LATER);
      expect(s.deliver(s.conn('b', readOnly), awarenessFrame(ids(700, AWARENESS_NEW_IDS_BURST)))).toBe('applied'); // per user
      t += AWARENESS_NEW_IDS_REFILL_MS;
      expect(s.deliver(s.conn('a', readOnly), awarenessFrame(ids(800, 1)))).toBe('applied'); // refilled one
      expect(s.deliver(s.conn('a', readOnly), awarenessFrame(ids(900, 2)))).toBe(TRY_LATER); // a frame is charged whole
    },
  );

  it(`every tab of the per-user cap (${COLLAB_CONNECTIONS_PER_USER}) announcing its id after a deploy passes`, () => {
    const s = setup({ seed: SEED, now: () => 1 });
    for (let i = 0; i < COLLAB_CONNECTIONS_PER_USER; i++) {
      const c = s.conn('many-tabs');
      expect(s.deliver(c, awarenessFrame([{ clientID: 50_000 + i, state: { user: { name: 'M' } } }]))).toBe('applied');
      expect(s.deliver(c, awarenessFrame([{ clientID: 50_000 + i, clock: 2, state: { user: { name: 'M' } } }]))).toBe('applied');
    }
    expect(s.limitLogs).toEqual([]);
  });

  it.each([['writer', false], ['reader', true]] as const)(
    'a %s: ids the document awareness already holds are not counted (a timeout removal of a 200-peer room passes)',
    (_who, readOnly) => {
      const s = setup({ seed: SEED });
      const meta = new Map<number, { clock: number }>();
      for (let i = 0; i < 200; i++) meta.set(1000 + i, { clock: 3 });
      (s.live as unknown as { awareness: unknown }).awareness = { meta };
      const room = Array.from({ length: 200 }, (_, i) => ({ clientID: 1000 + i, clock: 4, state: null }));
      expect(s.deliver(s.conn('a', readOnly), awarenessFrame(room))).toBe('applied');
      expect(s.deliver(s.conn('a', readOnly), awarenessFrame([...room, ...room.slice(0, AWARENESS_NEW_IDS_BURST).map((e) => ({ ...e, clientID: e.clientID + 5000 }))]))).toBe('applied');
    },
  );

  it('a client id twice in one frame is refused (y-protocols never encodes one twice)', () => {
    const s = setup({ seed: SEED });
    expect(s.deliver(s.conn('a', true), awarenessFrame([{ clientID: 5, state: {} }, { clientID: 5, clock: 2, state: {} }]))).toBe(REFUSED('awareness'));
  });

  it(`awareness binds stop at ${AWARENESS_BINDS_PER_USER} per user per document (never a refusal); other users still bind`, () => {
    let t = 1_000_000;
    const s = setup({ seed: SEED, now: () => t });
    const perConn = 32;
    let next = 10_000;
    // one writer over many connections (reconnects), over time (its new-id budget refills), tries to use up every bind
    for (let n = 0; n < AWARENESS_BINDS_PER_USER / perConn + 4; n++) {
      const entries = Array.from({ length: perConn }, () => ({ clientID: next++, state: { user: {} } }));
      expect(s.deliver(s.conn('hog'), awarenessFrame(entries))).toBe('applied');
      t += perConn * AWARENESS_NEW_IDS_REFILL_MS;
    }
    expect(s.guard.bindingCount(s.live)).toBe(1 + AWARENESS_BINDS_PER_USER); // live's own id + the hog's cap
    // an honest user who opens the page afterwards still binds its id, so its cursor cannot be spoken for
    expect(s.deliver(s.conn('honest'), awarenessFrame([{ clientID: 99_999, state: { user: { name: 'H' } } }]))).toBe('applied');
    expect(s.guard.bindingCount(s.live)).toBe(2 + AWARENESS_BINDS_PER_USER);
    expect(s.deliver(s.conn('hog'), awarenessFrame([{ clientID: 99_999, clock: 2, state: { user: { name: 'H' } } }]))).toBe(REFUSED('foreign-client'));
  });
});

describe('#790 frame bounds: Auth on an established session and unknown message types', () => {
  it('an Auth frame is refused auth (only an established session reaches the guard), any subtype', () => {
    const s = setup({ seed: SEED });
    for (const authType of [0, 1, 2]) {
      expect(s.deliver(s.conn('a'), authFrame('token', DOC_NAME, authType))).toBe(REFUSED('auth'));
    }
  });

  it('a type 4.7.1 does not handle is refused message-type; every type an honest provider sends passes', () => {
    const s = setup({ seed: SEED });
    for (const type of [MSG.SyncStatus, 9, 10, 11, 127, 300]) expect(s.deliver(s.conn('a'), typedFrame(type))).toBe(REFUSED('message-type'));
    const c = s.conn('writer');
    expect(s.deliver(c, typedFrame(MSG.QueryAwareness))).toBe('applied');
    expect(s.deliver(c, step1Frame(s.live))).toBe('applied');
    expect(s.deliver(c, awarenessFrame([{ clientID: 9, state: {} }]))).toBe('applied');
    expect(s.deliver(c, typedFrame(MSG.Close))).toBe('applied'); // a provider's detach
  });
});

describe('#790 awareness: no rate refusal in the guard (the rate is a drop at the gateway, frame-admission.ts)', () => {
  it.each([['writer', false], ['reader', true]] as const)(
    'a %s sending 1000 cursor frames in one millisecond is never refused: a refusal would end an honest session',
    (_who, readOnly) => {
      const s = setup({ seed: SEED, now: () => 2_000_000 });
      const c = s.conn('a', readOnly);
      for (let clock = 1; clock <= 1000; clock++) {
        const frame = awarenessFrame([{ clientID: 4242, clock, state: { user: { name: 'W' }, cursor: { anchor: clock, head: clock } } }]);
        expect(s.deliver(c, frame)).toBe('applied');
      }
      for (let i = 0; i < 100; i++) expect(s.deliver(c, typedFrame(MSG.QueryAwareness))).toBe('applied');
    },
  );
});

describe('#790 awareness: no state for another user\'s client id', () => {
  const withMeta = () => {
    const s = setup({ seed: SEED });
    const meta = new Map<number, { clock: number }>();
    (s.live as unknown as { awareness: unknown }).awareness = { meta };
    return { s, meta };
  };

  it('control: before any binding, a writer can announce a state for any id (nothing says whose it is)', () => {
    const { s } = withMeta();
    expect(s.deliver(s.conn('attacker'), awarenessFrame([{ clientID: 1001, clock: 5, state: { user: { name: 'Victim' } } }]))).toBe('applied');
  });

  it.each([['writer', false], ['reader', true]] as const)(
    'a %s announcing a newer state for an id bound to another user is refused foreign-client',
    (_who, readOnly) => {
      const { s, meta } = withMeta();
      expect(s.deliver(s.conn('victim'), awarenessFrame([{ clientID: 1001, clock: 1, state: { user: { name: 'V' } } }]))).toBe('applied');
      meta.set(1001, { clock: 1 });
      expect(s.deliver(s.conn('attacker', readOnly), awarenessFrame([{ clientID: 1001, clock: 2, state: { user: { name: 'Fake' } } }]))).toBe(REFUSED('foreign-client'));
      // an id no awareness ever held but bound by its structs is protected too
      const bound = new RemoteClient(s.live, 2002);
      expect(s.send(s.conn('victim'), bound.edit(s.live, (f) => textOf(f.get(0) as Y.XmlElement).insert(0, 'v ')))).toBe('applied');
      expect(s.deliver(s.conn('attacker', readOnly), awarenessFrame([{ clientID: 2002, clock: 1, state: { user: {} } }]))).toBe(REFUSED('foreign-client'));
      // and the server's own
      expect(s.deliver(s.conn('attacker', readOnly), awarenessFrame([{ clientID: s.live.clientID, clock: 1, state: {} }]))).toBe(REFUSED('foreign-client'));
    },
  );

  it('honest traffic about another user\'s id passes: a timeout removal, an echo at a held clock; the owner itself always', () => {
    const { s, meta } = withMeta();
    const victim = s.conn('victim');
    expect(s.deliver(victim, awarenessFrame([{ clientID: 1001, clock: 3, state: { user: { name: 'V' } } }]))).toBe('applied');
    meta.set(1001, { clock: 3 });
    // a peer's provider removes a peer that went quiet: clock + 1, state null
    expect(s.deliver(s.conn('peer'), awarenessFrame([{ clientID: 1001, clock: 4, state: null }]))).toBe('applied');
    // a 3.x provider echoes what it was relayed
    expect(s.deliver(s.conn('peer'), awarenessFrame([{ clientID: 1001, clock: 3, state: { user: { name: 'V' } } }]))).toBe('applied');
    // the owner, on the same or a new connection (a reconnect after a deploy keeps the Y.Doc and its id)
    expect(s.deliver(victim, awarenessFrame([{ clientID: 1001, clock: 5, state: { user: { name: 'V' } } }]))).toBe('applied');
    expect(s.deliver(s.conn('victim'), awarenessFrame([{ clientID: 1001, clock: 6, state: { user: { name: 'V' } } }]))).toBe('applied');
    // one frame can mix a peer's removal with the sender's own state (y-protocols batches changed clients)
    expect(s.deliver(s.conn('peer'), awarenessFrame([{ clientID: 1001, clock: 7, state: null }, { clientID: 3003, clock: 1, state: { user: { name: 'P' } } }]))).toBe('applied');
  });
});

describe('#810 (A5): every Hocuspocus MessageType is classified, from the library enum', () => {
  // The guard reads Hocuspocus's own enum (no local copy). This pins each member's outcome on an established session, so
  // a Hocuspocus bump that adds a type goes red here until someone classifies it.
  const EXPECTED: Record<string, 'applied' | string> = {
    Sync: 'applied',
    Awareness: 'applied',
    Auth: REFUSED('auth'),
    QueryAwareness: 'applied',
    SyncReply: 'applied',
    Stateless: REFUSED('stateless'),
    BroadcastStateless: REFUSED('stateless'),
    CLOSE: 'applied',
    SyncStatus: REFUSED('message-type'),
    Ping: REFUSED('message-type'),
    Pong: REFUSED('message-type'),
  };

  it('the table covers exactly the enum members a client can put on the wire (Unknown = -1 is not a varint)', () => {
    const members = Object.entries(MessageType).filter(([, v]) => typeof v === 'number' && v >= 0).map(([k]) => k);
    expect(members.sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(MessageType.Unknown).toBe(-1);
  });

  it.each(Object.keys(EXPECTED))('%s', (name) => {
    const s = setup({ seed: SEED });
    const type = MessageType[name as keyof typeof MessageType] as number;
    // Sync and SyncReply carry a Step1 so the frame reaches the HANDLED check (a bodiless one is left to Hocuspocus)
    const frame =
      type === MessageType.Sync || type === MessageType.SyncReply
        ? typedFrame(type, (e) => {
            encoding.writeVarUint(e, SYNC.Step1);
            encoding.writeVarUint8Array(e, Y.encodeStateVector(s.live));
          })
        : typedFrame(type);
    expect(s.deliver(s.conn('writer'), frame)).toBe(EXPECTED[name]);
  });
});
