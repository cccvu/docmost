import * as Y from 'yjs';
import { initProseMirrorDoc, prosemirrorJSONToYDoc, updateYFragment } from '@tiptap/y-tiptap';
import { Node as PMNode } from '@tiptap/pm/model';
import { TableMap } from '@tiptap/pm/tables';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { MessageType } from '@hocuspocus/server';
import * as encoding from 'lib0/encoding';
import { htmlToJson, jsonToHtml } from '../../collaboration/collaboration.util';
import { serverSchema } from '../page-write/prelim-content';
import { isDuplicateWriteKey, recordWriteKey, scopedWriteKey, WRITE_IDEM_MAP } from '../page-write/write-idem';
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
import { COLLAB_PAGE_COMPACTING_REASON } from './collab-reasons';
import { CONFLICT_SCAN_STEPS_PER_FRAME } from './conflict-scan';
import {
  basePage,
  blocksOf,
  distinctRightShape,
  encodeStructs,
  keyedHistoryShape,
  rawUpdate,
  rightLeftOfOriginShape,
  siblingsFrame,
  siblingsShape,
  twoClientsShape,
  unguardedSteps,
  type Shape,
  type StructBlock,
} from './conflict-scan.testkit';
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
  NEW_CLIENT_IDS_PER_FRAME,
  SOCKET_REFUSAL_BUDGET,
  SYNC_BURST,
  SYNC_REFILL_MS,
  TRY_LATER_REASON,
  USER_DOC_BUDGETS_MAX,
  USER_SYNC_BURST,
  USER_SYNC_REFILL_MS,
  USER_COLLAB_CPU_BURST_MS,
  USER_COLLAB_CPU_REFILL_MS_PER_SECOND,
  UNRESOLVED_REASON,
  type CollabGuardMode,
  type CollabGuardOptions,
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
/** #827: the socket closed 1013 with the compacting reason. */
const COMPACTING = 'compacting';

type Conn = { readOnly: boolean; webSocket: { close: jest.Mock }; context: { user: { id: string } } };

function setup(
  opts: {
    mode?: CollabGuardMode;
    seed?: unknown | Y.Doc;
    seedY?: (f: Y.XmlFragment, d: Y.Doc) => void;
    legacy?: Uint8Array;
    now?: () => number;
    cpuNow?: () => number;
    caps?: CollabGuardOptions['caps'];
  } = {},
) {
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
    cpuNow: opts.cpuNow,
    caps: opts.caps,
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
      if (err?.code === COLLAB_TRY_LATER_CODE && err?.reason === COLLAB_PAGE_COMPACTING_REASON) {
        expect(c.webSocket.close).toHaveBeenLastCalledWith(COLLAB_TRY_LATER_CODE, COLLAB_PAGE_COMPACTING_REASON);
        return COMPACTING; // #827: a 1013 that names the compaction
      }
      if (err?.code === COLLAB_TRY_LATER_CODE) {
        expect(err).toEqual({ code: COLLAB_TRY_LATER_CODE, reason: TRY_LATER_REASON });
        // the socket is closed FIRST, so Hocuspocus's document CLOSE (sent after the throw) never reaches the editor
        expect(c.webSocket.close).toHaveBeenLastCalledWith(COLLAB_TRY_LATER_CODE, TRY_LATER_REASON);
        return TRY_LATER;
      }
      expect(err).toEqual({ code: COLLAB_REFUSAL_CODE, reason: expect.any(String) });
      return err.reason;
    }
    if (apply) Y.applyUpdate(live, apply, { source: 'connection', connection: c }); // #840: 4.7.1's origin for a client frame
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

  it('bound by a non-readOnly awareness frame: the forged struct is never applied; the victim\'s own edits pass', () => {
    const { s, victim, vc } = victimSetup();
    expect(s.deliver(vc, awarenessFrame([{ clientID: 1001, state: { user: { name: 'V' } } }]))).toBe('applied');
    // Before the victim writes at its id, new clocks there are answered unresolved (refused, never applied: the mirror
    // race after a lost lifetime, relay-binding.spec.ts); once it has written, they are foreign-client.
    expectRefused(s, s.conn('attacker'), forge(s, 1001, 'FORGED '), UNRESOLVED_REASON);
    expect(s.send(vc, victim.edit(s.live, () => textOf(find(victim.doc, 'paragraph')).insert(0, 'MINE ')))).toBe('applied');
    expect(renderLikeABrowser(s.live).text).toContain('MINE');
    expectRefused(s, s.conn('attacker'), forge(s, 1001, 'FORGED '), REFUSED('foreign-client'));
  });

  // A regenerated client id is NOT bound this way once its connection announced its old id: relay-binding.spec.ts pins it.
  it('bound by the first new struct when the connection announced nothing (a pagehide-nulled awareness)', () => {
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
    expectRefused(s, s.conn('attacker'), forge(s, 1001, 'FORGED '), UNRESOLVED_REASON); // bound by awareness only so far
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
  // Ledger entries are digests (write-idem.ts): a forger writes the digest of a key it wants to suppress.
  const VICTIM = scopedWriteKey('victim', 'victim-key');
  const FORGED = scopedWriteKey('victim', 'forged-key');
  const ledgerSetup = () => {
    const s = setup({ seed: SEED });
    s.live.transact(() => recordWriteKey(s.live, VICTIM, Date.now()));
    return s;
  };
  it('forging a ledger entry: control flips isDuplicateWriteKey; treatment refuses root', () => {
    const s = ledgerSetup();
    const u = new RemoteClient(s.live).edit(s.live, (_f, d) => d.getMap(WRITE_IDEM_MAP).set(FORGED.entry, 1));
    expect(isDuplicateWriteKey(unguarded(s.live, u), FORGED)).toBe(true);
    expectRefused(s, s.conn('attacker'), u, REFUSED('root'));
  });
  it('overwriting and deleting the victim\'s entry: control drops it; treatment refuses root', () => {
    const changes: Array<[boolean, (m: Y.Map<unknown>) => void]> = [
      [false, (m) => m.set(VICTIM.entry, 'x')],
      [true, (m) => m.delete(VICTIM.entry)],
    ];
    for (const [drops, change] of changes) {
      const s = ledgerSetup();
      const u = new RemoteClient(s.live).edit(s.live, (_f, d) => change(d.getMap(WRITE_IDEM_MAP)));
      if (drops) expect(isDuplicateWriteKey(unguarded(s.live, u), VICTIM)).toBe(false); // control
      expectRefused(s, s.conn('attacker'), u, REFUSED('root'));
      expect(isDuplicateWriteKey(s.live, VICTIM)).toBe(true);
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

/**
 * The v0.12.3 incident (#781 lineage): a writer's second visit to any page that ever had a keyed `/v1` write was refused
 * `root`, because the stateless pre-pass judged structs live already held. y-indexeddb stores every root the server
 * syncs (the `__ccc_write_idem` ledger too) and, on the next mount, applies the stored state in ONE transaction with
 * itself as origin; HocuspocusProvider 4.7.1 drops only its own origin, so it sends that state back as an Update.
 */
describe('#781 a remount resending structs live already holds is not refused (the ledger echo)', () => {
  const IDB = Symbol('y-indexeddb');
  /** What the provider sends after a remount: the update event of y-indexeddb's load transaction on a fresh doc. */
  const remountEcho = (stored: Y.Doc): Uint8Array => {
    const fresh = new Y.Doc();
    let echo: Uint8Array | null = null;
    fresh.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin === IDB) echo = u;
    });
    Y.transact(fresh, () => Y.applyUpdate(fresh, Y.encodeStateAsUpdate(stored)), IDB, false);
    expect(echo).not.toBeNull();
    return echo!;
  };
  const ledgerItems = (update: Uint8Array): Y.Item[] =>
    Y.decodeUpdate(update).structs.filter((st): st is Y.Item => st instanceof Y.Item && (st.parent as unknown) === WRITE_IDEM_MAP);
  /** The seed's client: live holds its clocks, and no user is bound to it (live's own id is the server's). */
  const seedClient = (s: ReturnType<typeof setup>): number => ((textOf(find(s.live, 'paragraph')) as any)._start as Y.Item).id.client;
  const ARMS: Array<[string, (live: Y.Doc) => void]> = [
    ['one live entry', (live) => live.transact(() => recordWriteKey(live, scopedWriteKey('u', 'k1'), Date.now()))],
    [
      'every entry pruned (ContentDeleted)',
      (live) => {
        live.transact(() => recordWriteKey(live, scopedWriteKey('u', 'k1'), 1_000));
        live.transact(() => recordWriteKey(live, scopedWriteKey('u', 'k2'), 1_000_000, 10)); // prunes k1 by age
        live.transact(() => live.getMap(WRITE_IDEM_MAP).delete(scopedWriteKey('u', 'k2').entry));
        expect(live.getMap(WRITE_IDEM_MAP).size).toBe(0);
      },
    ],
  ];

  it.each(ARMS)('%s: the echo is applied (Update and Step2) as a no-op; a shadow rebuild replaying it stays one', (_arm, write) => {
    for (const subtype of [SYNC.Update, SYNC.Step2]) {
      const s = setup({ seed: SEED });
      write(s.live);
      const echo = remountEcho(s.live);
      // non-vacuity (i): the echo carries the server's ledger items, by root name; (iii) the last one ends exactly at
      // live's state for the server's client (the `<=` edge of the held predicate)
      const ledger = ledgerItems(echo);
      expect(ledger.length).toBeGreaterThan(0);
      expect(ledger.every((st) => st.id.client === s.live.clientID)).toBe(true);
      expect(Math.max(...ledger.map((st) => st.id.clock + st.length))).toBe(Y.getState(s.live.store, s.live.clientID));
      const before = s.snapshot();
      const editor = s.conn('editor');
      expect(s.send(editor, echo, subtype)).toBe('applied');
      const after = s.snapshot();
      expect(sameBytes(after.live, before.live)).toBe(true);
      expect(sameBytes(after.peer, before.peer)).toBe(true);
      expect(s.logs.filter((l) => l.startsWith('COLLAB_UPDATE_REFUSED'))).toEqual([]);
      expect(sameBytes(Y.encodeStateVector(s.guard.shadowOf(s.live)!), Y.encodeStateVector(s.live))).toBe(true);
      // Another user's shadow-stage refusal (a ledger overwrite) leaves the shadow dirty: the next frame's rebuild replays
      // the echo from the in-flight list, still a no-op, and the editor's next edit applies.
      const overwrite = new RemoteClient(s.live).edit(s.live, (_f, d) => d.getMap(WRITE_IDEM_MAP).set(scopedWriteKey('u', 'k1').entry, 'x'));
      expect(s.send(s.conn('attacker'), overwrite)).toBe(REFUSED('root'));
      const c = new RemoteClient(s.live);
      expect(s.send(editor, c.edit(s.live, (f) => textOf(f.get(0) as Y.XmlElement).insert(0, 'next ')))).toBe('applied');
      expect(renderLikeABrowser(s.live).text).toBe('next victim text');
      expect(sameBytes(Y.encodeStateVector(s.guard.shadowOf(s.live)!), Y.encodeStateVector(s.live))).toBe(true);
      // non-vacuity (ii): the SAME bytes to a live that lacks the ledger are new structs in another root, refused root
      // in the pre-pass (a fresh setup: its seed has another client id, so nothing of the echo is held there)
      const other = setup({ seed: SEED });
      expect(other.live.share.has(WRITE_IDEM_MAP)).toBe(false);
      expectRefused(other, other.conn('editor'), echo, REFUSED('root'), subtype);
      expect(other.guard.shadowOf(other.live)).toBeNull();
    }
  });

  it('the echo merged with an honest edit is applied; merged with a client ledger delete or overwrite it is refused root', () => {
    const s = setup({ seed: SEED });
    s.live.transact(() => recordWriteKey(s.live, scopedWriteKey('u', 'k1'), Date.now()));
    const edit = new RemoteClient(s.live).edit(s.live, (f) => textOf(f.get(0) as Y.XmlElement).insert(0, 'new '));
    expect(s.send(s.conn('editor'), Y.mergeUpdates([remountEcho(s.live), edit]))).toBe('applied');
    expect(renderLikeABrowser(s.live).text).toBe('new victim text');
    const changes: Array<(m: Y.Map<unknown>) => void> = [(m) => m.delete(scopedWriteKey('u', 'k1').entry), (m) => m.set(scopedWriteKey('u', 'k1').entry, 'x')];
    for (const change of changes) {
      const t = setup({ seed: SEED });
      t.live.transact(() => recordWriteKey(t.live, scopedWriteKey('u', 'k1'), Date.now()));
      const u = new RemoteClient(t.live).edit(t.live, (_f, d) => change(d.getMap(WRITE_IDEM_MAP)));
      expectRefused(t, t.conn('attacker'), Y.mergeUpdates([remountEcho(t.live), u]), REFUSED('root'));
      expect(isDuplicateWriteKey(t.live, scopedWriteKey('u', 'k1'))).toBe(true);
    }
  });

  it('a struct at a clock live holds that names a root live lacks is refused root, and live.share does not grow', () => {
    const s = setup({ seed: SEED });
    const client = seedClient(s);
    const u = rawUpdate([{ client, clock: 0, structs: [{ origin: null, right: null, parent: 'evil-root', sub: 'a', content: new Y.ContentAny([1]) }] }]);
    expect(Y.getState(s.live.store, client)).toBeGreaterThanOrEqual(1); // precondition: clock 0, length 1 is held
    // control: Yjs integrates nothing, yet its decode creates the root (so a stream of such frames grows `share`)
    const control = unguarded(s.live, u);
    expect(control.share.has('evil-root')).toBe(true);
    expect(sameBytes(Y.encodeStateVector(control), Y.encodeStateVector(s.live))).toBe(true);
    expectRefused(s, s.conn('attacker'), u, REFUSED('root'));
    expect([...s.live.share.keys()]).not.toContain('evil-root');
    expect(s.guard.shadowOf(s.live)).toBeNull(); // the pre-pass refused it
  });

  it('a struct live holds only in part (a straddle on a root live holds) is judged whole by the pre-pass', () => {
    const s = setup({ seed: SEED });
    s.live.transact(() => recordWriteKey(s.live, scopedWriteKey('u', 'k1'), Date.now()));
    const client = seedClient(s);
    const state = Y.getState(s.live.store, client);
    const u = rawUpdate([
      { client, clock: state - 1, structs: [{ origin: null, right: null, parent: WRITE_IDEM_MAP, content: new Y.ContentAny([1, 2, 3, 4, 5, 6, 7, 8]) }] },
    ]);
    // precondition: the head is held, the tail is new, and live holds the root it names
    expect(state - 1).toBeGreaterThanOrEqual(0);
    expect(s.live.share.has(WRITE_IDEM_MAP)).toBe(true);
    expectRefused(s, s.conn('attacker'), u, REFUSED('root'));
    // the pre-pass refused it: judging only a struct's head (`clock < state`) would leave this to the shadow
    expect(s.guard.shadowOf(s.live)).toBeNull();

    // the upper boundary: a struct new by exactly ONE clock is still judged whole (`clock + length <= state`, not `- 1`)
    const t = setup({ seed: SEED });
    t.live.transact(() => recordWriteKey(t.live, scopedWriteKey('u', 'k1'), Date.now()));
    const c2 = seedClient(t);
    const st = Y.getState(t.live.store, c2);
    const byOne = rawUpdate([
      { client: c2, clock: st - 1, structs: [{ origin: null, right: null, parent: WRITE_IDEM_MAP, content: new Y.ContentAny([1, 2]) }] },
    ]);
    const decoded = Y.decodeUpdate(byOne).structs[0];
    // precondition: one clock held, exactly one clock new
    expect(decoded.id.clock + decoded.length - st).toBe(1);
    expect(t.live.share.has(WRITE_IDEM_MAP)).toBe(true);
    expectRefused(t, t.conn('attacker'), byOne, REFUSED('root'));
    expect(t.guard.shadowOf(t.live)).toBeNull();
  });

  it('a zero-length struct at the clock live is at is refused zero-length (Yjs integrates it: offset 0)', () => {
    const s = setup({ seed: SEED });
    const t = textOf(find(s.live, 'paragraph'));
    const first = ((t as any)._start as Y.Item).id;
    const client = seedClient(s);
    const clock = Y.getState(s.live.store, client);
    const u = rawUpdate([{ client, clock, structs: [{ origin: [first.client, first.clock], right: null, content: new Y.ContentString('') }] }]);
    expect(Y.decodeUpdate(u).structs[0].length).toBe(0); // precondition: zero length, at exactly live's state
    expectRefused(s, s.conn('attacker'), u, REFUSED('zero-length'));
  });

  it('a frame of held structs only is still judged on its delete set: ranges out of order are refused delete-order', () => {
    const s = setup({ seed: SEED });
    const at = ((textOf(find(s.live, 'paragraph')) as any)._start as Y.Item).id;
    const held = { client: at.client, clock: at.clock, structs: [{ origin: null, right: null, parent: 'default', content: new Y.ContentString('zz') }] };
    const u = rawUpdate([held], [{ client: at.client, ranges: [[at.clock + 8, 1], [at.clock + 5, 1]] }]);
    expect(Y.getState(s.live.store, at.client)).toBeGreaterThanOrEqual(at.clock + 2); // precondition: the struct is held
    expectRefused(s, s.conn('attacker'), u, REFUSED('delete-order'));
    expect(s.guard.shadowOf(s.live)).toBeNull();
    // the same held struct with the ranges ascending is applied (the deletes are new, and harmless)
    const ok = rawUpdate([held], [{ client: at.client, ranges: [[at.clock + 5, 1], [at.clock + 8, 1]] }]);
    expect(s.send(s.conn('honest'), ok)).toBe('applied');
    expect(renderLikeABrowser(s.live).text).toBe('victi txt');
  });

  it('a held struct still meets Yjs: a forged same-client parent id past live\'s state throws in the shadow (internal)', () => {
    const s = setup({ seed: SEED });
    const at = ((textOf(find(s.live, 'paragraph')) as any)._start as Y.Item).id;
    const u = rawUpdate([{ client: at.client, clock: at.clock, structs: [{ origin: null, right: null, parent: [at.client, 9_999], content: new Y.ContentString('x') }] }]);
    expect(Y.getState(s.live.store, at.client)).toBeGreaterThan(at.clock); // precondition: held, its parent clock is not
    expect(Y.getState(s.live.store, at.client)).toBeLessThan(9_999);
    expect(() => unguarded(s.live, u)).toThrow(); // control: Yjs's getMissing throws on it
    expectRefused(s, s.conn('attacker'), u, REFUSED('internal'));
  });

  const LEGACY: Array<[string, (d: Y.Doc) => void]> = [
    ['string-attr', (d) => textOf(find(d, 'paragraph')).format(0, 6, { link: { href: { evil: 1 } } })],
    ['schema', (d) => d.getXmlFragment('default').insert(1, [new Y.XmlElement('notANode')])],
    ['content-kind', (d) => textOf(find(d, 'paragraph')).insertEmbed(2, { a: 1 })],
    ['attr-kind', (d) => find(d, 'paragraph').setAttribute('__proto__', 'x' as never)],
  ];
  it.each(LEGACY)('stored pre-#781 content a stateless rule refuses (%s): its echo is applied, the same value new is refused', (rule, write) => {
    const legacy = prosemirrorJSONToYDoc(schema, SEED, 'default');
    legacy.transact(() => write(legacy));
    const s = setup({ legacy: Y.encodeStateAsUpdate(legacy) });
    const before = Y.encodeStateAsUpdate(s.live);
    expect(s.send(s.conn('editor'), remountEcho(s.live))).toBe('applied');
    expect(sameBytes(Y.encodeStateAsUpdate(s.live), before)).toBe(true);
    // the same value in a struct live does not hold is refused by the same rule
    const c = new RemoteClient(s.live);
    expectRefused(s, s.conn('attacker'), c.edit(s.live, (_f, d) => write(d)), REFUSED(rule));
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

  it('a struct live holds in full is never integrated; a straddling one only from beforeState; a root name is created at decode', () => {
    const live = new Y.Doc();
    live.getArray('a').insert(0, [1, 2, 3]);
    const c = live.clientID;
    let updates = 0;
    live.on('update', () => updates++);
    const sv = Y.encodeStateVector(live);
    // (a) held in full: no update event, the state vector unchanged, nothing integrated (integrateStructs' offset rule)
    Y.applyUpdate(live, rawUpdate([{ client: c, clock: 0, structs: [{ origin: null, right: null, parent: 'a', content: new Y.ContentAny([9, 9, 9]) }] }]));
    expect(updates).toBe(0);
    expect(sameBytes(Y.encodeStateVector(live), sv)).toBe(true);
    expect(live.getArray('a').toArray()).toEqual([1, 2, 3]);
    // (c) held, naming a root live lacks: still no update, but readClientsStructRefs' doc.get created the root
    Y.applyUpdate(live, rawUpdate([{ client: c, clock: 1, structs: [{ origin: null, right: null, parent: 'zzz', sub: 'k', content: new Y.ContentAny([1]) }] }]));
    expect(updates).toBe(0);
    expect(live.share.has('zzz')).toBe(true);
    // (b) a straddle: only the tail integrates, and it starts at the transaction's beforeState
    Y.transact(live, (tr) => {
      Y.applyUpdate(live, rawUpdate([{ client: c, clock: 2, structs: [{ origin: null, right: null, parent: 'a', content: new Y.ContentAny([7, 8]) }] }]));
      const structs = live.store.clients.get(c)!;
      const fresh = structs.slice(Y.findIndexSS(structs, tr.beforeState.get(c)!));
      expect(fresh.map((st) => [st.id.clock, st.length])).toEqual([[3, 1]]);
    }, 'probe', false);
    expect(live.getArray('a').toArray()).toEqual([1, 2, 3, 8]);
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
    // #827: QueryAwareness too: the 4.7.1 provider never sends it, and 4.7.1 answers it by encoding every awareness state
    for (const type of [MSG.SyncStatus, MSG.QueryAwareness, 9, 10, 11, 127, 300]) {
      expect(s.deliver(s.conn('a'), typedFrame(type))).toBe(REFUSED('message-type'));
    }
    const c = s.conn('writer');
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
    QueryAwareness: REFUSED('message-type'), // #827: no 4.7.1 provider sends it; 4.7.1 encodes every state for nothing
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

describe('#810 (C2): a 3.4.4 tab\'s queued "remove every peer" awareness frame, replayed after the 4.7.1 deploy', () => {
  // A 3.4.4 provider's onClose removed every peer's awareness state and queued that frame while its socket was closed;
  // 4.7.1 providers never send one. Its removals name ids the freshly loaded document's awareness has never held, so
  // they count against the (user, document) new-ids budget: they must stay counted (y-protocols writes `meta` for an
  // unknown id removed at clock >= 1 and never prunes it), and past the budget the outcome must be recoverable.
  // y-protocols as Hocuspocus 4.7.1 resolves it (the server does not declare it), so `meta` is what Hocuspocus keeps.
  interface AwarenessLike {
    meta: Map<number, { clock: number }>;
    destroy(): void;
  }
  const yAwareness = (): {
    Awareness: new (doc: Y.Doc) => AwarenessLike;
    applyAwarenessUpdate: (a: AwarenessLike, update: Uint8Array, origin: unknown) => void;
  } =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require(require.resolve('y-protocols/awareness', { paths: [require('node:path').dirname(require.resolve('@hocuspocus/server'))] }));
  /** The awareness update an Awareness frame carries (what Hocuspocus hands applyAwarenessUpdate). */
  const updateOf = (frame: Uint8Array): Uint8Array => {
    const d = decoding.createDecoder(frame);
    decoding.readVarString(d);
    decoding.readVarUint(d);
    return decoding.readVarUint8Array(d);
  };
  const decoding = jest.requireActual<typeof import('lib0/decoding')>('lib0/decoding');
  const removals = (from: number, n: number, clock = 2) => Array.from({ length: n }, (_, i) => ({ clientID: from + i, clock, state: null }));

  const opened: AwarenessLike[] = [];
  afterEach(() => opened.splice(0).forEach((a) => a.destroy())); // its renewal interval would keep jest running

  /** The guard first; when it passes, the frame applied to a real y-protocols Awareness, as Hocuspocus does. */
  const room = () => {
    const s = setup({ seed: SEED, now: () => 1_000_000 });
    const { Awareness, applyAwarenessUpdate } = yAwareness();
    const awareness = new Awareness(s.live);
    opened.push(awareness);
    (s.live as unknown as { awareness: AwarenessLike }).awareness = awareness;
    const send = (c: Conn, entries: Array<{ clientID: number; clock?: number; state: unknown }>) => {
      const frame = awarenessFrame(entries);
      const outcome = s.deliver(c, frame);
      if (outcome === 'applied') applyAwarenessUpdate(awareness, updateOf(frame), c);
      return outcome;
    };
    return { s, awareness, send };
  };

  it(`removals of ${AWARENESS_NEW_IDS_BURST + 1} unknown ids (clock >= 1): 1013 (try later), never a refusal; meta grows by at most ${AWARENESS_NEW_IDS_BURST}`, () => {
    const { s, awareness, send } = room();
    const before = awareness.meta.size;
    const stale = s.conn('stale-tab');
    expect(send(stale, removals(9_000, AWARENESS_NEW_IDS_BURST + 1))).toBe(TRY_LATER);
    expect(awareness.meta.size).toBe(before); // refused whole: nothing applied
    // the tab reconnects (a new connection, the same user and document), and the budget it has left is what passes
    expect(send(s.conn('stale-tab'), removals(9_000, AWARENESS_NEW_IDS_BURST))).toBe('applied');
    expect(awareness.meta.size - before).toBe(AWARENESS_NEW_IDS_BURST); // y-protocols kept a meta entry for each
    expect(send(s.conn('stale-tab'), removals(9_000 + AWARENESS_NEW_IDS_BURST, 1))).toBe(TRY_LATER);
    expect(awareness.meta.size - before).toBe(AWARENESS_NEW_IDS_BURST);
    expect(s.limitLogs.every((l) => l.includes('"limit":"user_awareness_ids"'))).toBe(true);
    expect(s.logs.filter((l) => l.includes('COLLAB_UPDATE_REFUSED'))).toEqual([]);
  });

  it('once those peers have re-announced (their ids are in meta), the same removal frame applies, uncounted', () => {
    const { s, awareness, send } = room();
    const ids = removals(9_000, AWARENESS_NEW_IDS_BURST + 1);
    for (const { clientID } of ids) expect(send(s.conn(`peer-${clientID}`), [{ clientID, clock: 1, state: { user: { name: 'P' } } }])).toBe('applied');
    expect(send(s.conn('stale-tab'), ids)).toBe('applied');
    expect(s.limitLogs).toEqual([]);
  });
});

describe('#810 (L1) the guard logs through the shared per-key window: per token, and the final count by timer', () => {
  afterEach(() => jest.useRealTimers());
  /** The guard's private `log` (only COLLAB_LEGACY_PENDING_INVALID and COLLAB_UPDATE_REFUSED reach it). */
  const logOf = (guard: CollabUpdateGuard) =>
    (guard as unknown as { log(token: string, live: Y.Doc, fields: Record<string, unknown>): void }).log.bind(guard);

  it('a flood of one token (legacy content on every page load) cannot suppress a refusal line', () => {
    jest.useFakeTimers({ now: 3_000_000 });
    const s = setup({ seed: SEED });
    for (let i = 0; i < 100; i++) logOf(s.guard)('COLLAB_LEGACY_PENDING_INVALID', s.live, { rule: 'legacy' });
    expect(s.logs.filter((l) => l.startsWith('COLLAB_LEGACY_PENDING_INVALID '))).toHaveLength(30);
    expect(s.deliver(s.conn('a'), statelessFrame('{"type":"page.updated"}', MSG.Stateless))).toBe(REFUSED('stateless'));
    expect(s.logs.filter((l) => l.startsWith('COLLAB_UPDATE_REFUSED '))).toHaveLength(1);
  });

  it('the suppressed count is written at the end of the window with no further line, as COLLAB_GUARD_LOG_SUPPRESSED with `of`', () => {
    jest.useFakeTimers({ now: 3_000_000 });
    const s = setup({ seed: SEED });
    for (let i = 0; i < 42; i++) logOf(s.guard)('COLLAB_LEGACY_PENDING_INVALID', s.live, { rule: 'legacy' });
    expect(s.logs.filter((l) => l.startsWith('COLLAB_GUARD_LOG_SUPPRESSED'))).toEqual([]);
    jest.advanceTimersByTime(60_000);
    expect(s.logs.filter((l) => l.startsWith('COLLAB_GUARD_LOG_SUPPRESSED'))).toEqual([
      'COLLAB_GUARD_LOG_SUPPRESSED {"of":"COLLAB_LEGACY_PENDING_INVALID","count":12}',
    ]);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('#816 conflict scan: a frame whose integrate walks would stall the process is refused before Yjs walks them', () => {
  /** The steps of the same frame over twice the size: ~4x is quadratic (a count, never a wall-clock stall). */
  const growth = (build: (n: number) => Shape, n: number) => {
    const small = build(n);
    const large = build(2 * n);
    return unguardedSteps(large.base, large.frame) / unguardedSteps(small.base, small.frame);
  };
  const honestAfter = (s: ReturnType<typeof setup>) =>
    s.send(s.conn('honest'), new RemoteClient(s.live).edit(s.live, (f) => textOf(f.get(0) as Y.XmlElement).insert(0, 'still editing ')));

  it.each([
    ['(b) two client ids: n·m', (n: number) => twoClientsShape(n), 1100],
    ['(c) one client id, distinct rightOrigins in one frame: m²', (n: number) => distinctRightShape(n), 1500],
    ['(d) a rightOrigin left of its origin: tail·m', (n: number) => rightLeftOfOriginShape(n), 1100],
    ['(e) a keyed history: history·m', (n: number) => keyedHistoryShape(n, n), 1100],
  ] as const)('%s: control grows quadratically; treatment refuses conflict-scan, live unchanged, the next frame passes', (_name, build, n) => {
    const ratio = growth(build, 200);
    expect(ratio).toBeGreaterThan(3.5); // control: doubling the attacker's bytes quadruples the walk
    expect(ratio).toBeLessThan(4.5);
    const shape = build(n);
    expect(unguardedSteps(shape.base, shape.frame)).toBeGreaterThan(CONFLICT_SCAN_STEPS_PER_FRAME); // the frame at hand
    const s = setup({ seed: shape.base });
    expectRefused(s, s.conn('attacker'), shape.frame, REFUSED('conflict-scan'));
    const line = s.logs.find((l) => l.includes('"rule":"conflict-scan"'))!;
    expect(JSON.parse(line.slice(line.indexOf('{')))).toMatchObject({ steps: CONFLICT_SCAN_STEPS_PER_FRAME + 1, mode: 'enforce' });
    expect(honestAfter(s)).toBe('applied');
  });

  it('(a) #816: siblings with client ids rising across frames: the first frame past the cap is refused, earlier ones pass', () => {
    // Each new id walks every sibling the page already holds, so a frame of 64 ids costs 64 x (siblings so far):
    // linear per frame, quadratic in the ids an attacker sends. Start just under the cap (as if earlier frames left it).
    let t = 1_000_000;
    const prior = Math.floor(CONFLICT_SCAN_STEPS_PER_FRAME / NEW_CLIENT_IDS_PER_FRAME) - NEW_CLIENT_IDS_PER_FRAME;
    const shape = siblingsShape(prior, 0);
    const from = 100_000 + prior;
    const frame = (k: number) => siblingsFrame(from + k * NEW_CLIENT_IDS_PER_FRAME, NEW_CLIENT_IDS_PER_FRAME, shape.first);
    // control: the per-frame walk grows with the siblings accumulated (2x the siblings, 2x the steps)
    const half = siblingsShape(prior / 2, 0);
    const perFrame = (sh: Shape, p: number) => unguardedSteps(sh.base, siblingsFrame(100_000 + p, NEW_CLIENT_IDS_PER_FRAME, sh.first));
    expect(perFrame(shape, prior) / perFrame(half, prior / 2)).toBeGreaterThan(1.9);
    // #816's per-frame scan alone: the seed's ~15k client ids and its load walk are past the #827 page caps (C_MAX,
    // W_MAX), which would compact it before this vector is reached
    const s = setup({ seed: shape.base, now: () => t, caps: { clientIds: Number.MAX_SAFE_INTEGER, steps: Number.MAX_SAFE_INTEGER } });
    const attacker = s.conn('attacker');
    expect(unguardedSteps(s.live, frame(0))).toBeLessThanOrEqual(CONFLICT_SCAN_STEPS_PER_FRAME);
    expect(s.send(attacker, frame(0))).toBe('applied');
    t += NEW_CLIENT_IDS_PER_FRAME * AWARENESS_NEW_IDS_REFILL_MS; // its id budget refilled: only the scan stops it
    expect(unguardedSteps(s.live, frame(1))).toBeGreaterThan(CONFLICT_SCAN_STEPS_PER_FRAME);
    expectRefused(s, attacker, frame(1), REFUSED('conflict-scan'));
    expect(honestAfter(s)).toBe('applied');
  });

  it('no cap per item: a keystroke typed before it saw 60,000 cheap concurrent siblings at its spot still applies', () => {
    // A co-editor (low client id) puts 60,000 siblings between two characters someone is typing between. Each walks
    // nothing (one client, same origins), so the frame is cheap and accepted. The typist's keystroke, made before it
    // saw them (a higher client id), walks every one of them: one item, ~60k steps, a few ms of Yjs.
    const page = basePage('ab');
    // #816's per-item rule only: 60,000 live siblings are past #827's live-struct cap (COMPACT_MAX_LIVE_STRUCTS), raised here
    const s = setup({ seed: page.doc, caps: { compactLive: 100_000 } });
    const typist = new Y.Doc();
    typist.clientID = 3_000_000_000;
    Y.applyUpdate(typist, Y.encodeStateAsUpdate(s.live));
    let keystroke: Uint8Array | null = null;
    typist.on('update', (u: Uint8Array) => (keystroke = u));
    textOf(typist.getXmlFragment('default').get(0) as Y.XmlElement).insert(1, 'v');
    const sibling = { origin: [1, page.first] as [number, number], right: [1, page.first + 1] as [number, number], content: new Y.ContentString('x') };
    const siblings = rawUpdate([{ client: 2, clock: 0, structs: Array.from({ length: 60_000 }, () => sibling) }]);
    expect(s.send(s.conn('co-editor'), siblings)).toBe('applied');
    const steps = unguardedSteps(s.live, keystroke!);
    expect(steps).toBeGreaterThan(50_000); // what a cap per item at 50,000 refused 4422
    expect(steps).toBeLessThan(CONFLICT_SCAN_STEPS_PER_FRAME);
    expect(s.send(s.conn('typist'), keystroke!)).toBe('applied');
    expect(textOf(s.live.getXmlFragment('default').get(0) as Y.XmlElement).toString()).toContain('v');
  });

  it('a frame worth ~1e8 steps (n = m = 10 000) is refused at the cap, never after the walk', () => {
    const shape = twoClientsShape(10_000);
    const s = setup({ seed: shape.base });
    // n·m + n - 1 steps unguarded (the meter spec pins the formula): ~100x the cap, a stall of seconds
    expectRefused(s, s.conn('attacker'), shape.frame, REFUSED('conflict-scan'));
    const line = s.logs.find((l) => l.includes('"rule":"conflict-scan"'))!;
    expect(JSON.parse(line.slice(line.indexOf('{')))).toMatchObject({ steps: CONFLICT_SCAN_STEPS_PER_FRAME + 1 });
  });

  it('report mode counts and never refuses: the frame applies, logged with the whole count', () => {
    const shape = twoClientsShape(1100);
    const s = setup({ seed: shape.base, mode: 'report' });
    expect(s.send(s.conn('attacker'), shape.frame)).toBe('applied');
    const line = s.logs.find((l) => l.includes('"rule":"conflict-scan"'))!;
    expect(JSON.parse(line.slice(line.indexOf('{')))).toMatchObject({ steps: unguardedSteps(shape.base, shape.frame), mode: 'report' });
    expect(Y.encodeStateVector(s.live)).toEqual(Y.encodeStateVector(unguarded(shape.base, shape.frame)));
  });

  it('fails closed: a meter error (getItem throws in the replay) is refused internal, stage conflict-scan; the shadow rebuilds', () => {
    const s = setup({ seed: SEED });
    const conn = s.conn('editor');
    const c = new RemoteClient(s.live, 4242);
    expect(s.send(conn, c.edit(s.live, (f) => textOf(f.get(0) as Y.XmlElement).insert(0, 'abc')))).toBe('applied');
    c.doc.transact(() => textOf(c.fragment.get(0) as Y.XmlElement).insert(3, 'd'));
    // A Step2 resending from one clock back (a reconnect's overlap): Yjs integrates it with offset 1, which reads getItem.
    const sv = Y.decodeStateVector(Y.encodeStateVector(s.live));
    sv.set(4242, sv.get(4242)! - 1);
    const overlap = Y.encodeStateAsUpdate(c.doc, Y.encodeStateVector(sv));
    const shadow = s.guard.shadowOf(s.live);
    const getItem = jest.spyOn(Y, 'getItem').mockImplementation(() => {
      throw new Error('injected');
    });
    try {
      expectRefused(s, s.conn('editor'), overlap, REFUSED('internal'), SYNC.Step2);
    } finally {
      getItem.mockRestore();
    }
    const line = s.logs.find((l) => l.includes('"rule":"internal"'))!;
    expect(line).toContain('"stage":"conflict-scan"');
    expect(s.send(s.conn('editor'), overlap, SYNC.Step2)).toBe('applied'); // the same frame, honest, after the fault
    expect(s.guard.shadowOf(s.live)).not.toBe(shadow); // rebuilt from live, unmetered
    expect(textOf(find(s.live, 'paragraph')).toString()).toBe('abcdvictim text');
  });
});

describe('#842 pre-pass shape rules: no zero-length struct of any kind, one block per client', () => {
  const X = 4242;
  /** One character at X's next clock, after the page's first character: an honest frame. */
  const oneChar = (s: ReturnType<typeof setup>, clock = Y.getState(s.live.store, X)) => {
    const first = ((textOf(find(s.live, 'paragraph')) as any)._start as Y.Item).id;
    return rawUpdate([{ client: X, clock, structs: [{ origin: clock ? [X, clock - 1] : [first.client, first.clock], right: null, content: new Y.ContentString('x') }] }]);
  };

  it('a zero-length GC: control, the page can no longer be encoded (stored, answered or rebuilt); refused zero-length', () => {
    const s = setup({ seed: SEED });
    expect(s.send(s.conn('writer'), oneChar(s))).toBe('applied');
    const gc = encodeStructs([{ client: X, clock: 1, structs: [new Y.GC(Y.createID(X, 1), 0)] }]);
    expect(Y.decodeUpdate(gc).structs[0]).toMatchObject({ length: 0 }); // precondition
    const control = unguarded(s.live, gc);
    expect(() => Y.encodeStateAsUpdate(control)).toThrow(); // the brick: findIndexSS divides by a zero-length span
    expectRefused(s, s.conn('attacker'), gc, REFUSED('zero-length'));
    expect(() => Y.encodeStateAsUpdate(s.live)).not.toThrow();
    expect(s.send(s.conn('writer'), oneChar(s))).toBe('applied'); // the page still takes edits
  });

  it('a flood of zero-length GCs (every one a struct in live, a few bytes each) is refused before any shadow work', () => {
    const s = setup({ seed: SEED });
    const n = 50_000;
    const flood = encodeStructs([{ client: X, clock: 0, structs: Array.from({ length: n }, () => new Y.GC(Y.createID(X, 0), 0)) }]);
    expect(flood.length).toBeLessThan(4 * n);
    const control = unguarded(s.live, flood);
    expect(control.store.clients.get(X)!.length).toBe(n); // Yjs integrates every one
    expectRefused(s, s.conn('attacker'), flood, REFUSED('zero-length'));
    expect(s.guard.shadowOf(s.live)).toBeNull();
  });

  it.each<[string, (s: ReturnType<typeof setup>) => Uint8Array]>([
    ['a zero-length Skip (between two honest characters)', (s) => withSkip(s)],
    [
      'a zero-length Item live already holds the clock of (held, and still refused)',
      (s) => {
        const at = ((textOf(find(s.live, 'paragraph')) as any)._start as Y.Item).id;
        return rawUpdate([{ client: at.client, clock: at.clock, structs: [{ origin: null, right: null, parent: 'default', content: new Y.ContentString('') }] }]);
      },
    ],
  ])('%s is refused zero-length', (_n, frame) => {
    const s = setup({ seed: SEED });
    expectRefused(s, s.conn('attacker'), frame(s), REFUSED('zero-length'));
  });
  /** An honest character at X, a zero-length Skip, then another character past the gap. */
  function withSkip(s: ReturnType<typeof setup>): Uint8Array {
    const first = ((textOf(find(s.live, 'paragraph')) as any)._start as Y.Item).id;
    const blocks = [
      {
        client: X,
        clock: 0,
        structs: [
          new Y.Item(Y.createID(X, 0), null, Y.createID(first.client, first.clock), null, null, null, null, new Y.ContentString('x')),
          new Y.Skip(Y.createID(X, 1), 0),
          new Y.Item(Y.createID(X, 1), null, Y.createID(X, 0), null, null, null, null, new Y.ContentString('y')),
        ],
      },
    ];
    return encodeStructs(blocks);
  }

  it('a repeated client block: control, Yjs applies only the last while its decode returns both; refused client-blocks', () => {
    const s = setup({ seed: SEED });
    const first = ((textOf(find(s.live, 'paragraph')) as any)._start as Y.Item).id;
    const at = (str: string) => new Y.Item(Y.createID(X, 0), null, Y.createID(first.client, first.clock), null, null, null, null, new Y.ContentString(str));
    const twice = encodeStructs([
      { client: X, clock: 0, structs: [at('GOOD')] },
      { client: X, clock: 0, structs: [at('BAD!')] },
    ]);
    expect(Y.decodeUpdate(twice).structs.map((st) => ((st as Y.Item).content as Y.ContentString).str)).toEqual(['GOOD', 'BAD!']);
    expect(renderLikeABrowser(unguarded(s.live, twice)).text).toBe('vBAD!ictim text');
    expectRefused(s, s.conn('attacker'), twice, REFUSED('client-blocks'));
    // so is a block with no structs (a count that names a client the section never writes)
    const empty = encodeStructs([{ client: X, clock: 0, structs: [at('ok')] }, { client: X + 1, clock: 0, structs: [] }]);
    expectRefused(s, s.conn('attacker'), empty, REFUSED('client-blocks'));
    // control: one block per client, several clients, is applied
    const two = encodeStructs([
      { client: X + 1, clock: 0, structs: [new Y.Item(Y.createID(X + 1, 0), null, Y.createID(first.client, first.clock), null, null, null, null, new Y.ContentString('b'))] },
      { client: X, clock: 0, structs: [at('a')] },
    ]);
    expect(s.send(s.conn('honest'), two)).toBe('applied');
  });

  it('report mode (the kill switch) still refuses both shapes, and a report-only rule elsewhere in the frame never masks them', () => {
    const s = setup({ seed: SEED, mode: 'report' });
    const first = ((textOf(find(s.live, 'paragraph')) as any)._start as Y.Item).id;
    const at = (str: string) => new Y.Item(Y.createID(X, 0), null, Y.createID(first.client, first.clock), null, null, null, null, new Y.ContentString(str));
    const gc: StructBlock = { client: X, clock: 0, structs: [new Y.GC(Y.createID(X, 0), 0)] };
    // alone: refused, and live stays encodable
    expectRefused(s, s.conn('a1'), encodeStructs([gc]), REFUSED('zero-length'));
    expectRefused(s, s.conn('a2'), encodeStructs([{ client: X, clock: 0, structs: [at('GOOD')] }, { client: X, clock: 0, structs: [at('BAD!')] }]), REFUSED('client-blocks'));
    expect(() => Y.encodeStateAsUpdate(s.live)).not.toThrow();
    // with a report-only content violation (an unknown mark) in the same frame, before or after it
    const bad = blocksOf(new RemoteClient(s.live, X + 7).edit(s.live, (f) => textOf(f.get(0) as Y.XmlElement).format(0, 2, { evil: {} })));
    const repeated: StructBlock[] = [
      { client: X, clock: 0, structs: [at('GOOD')] },
      { client: X, clock: 0, structs: [at('BAD!')] },
    ];
    let n = 0;
    for (const [blocks, rule] of [
      [[...bad.blocks, gc], 'zero-length'],
      [[gc, ...bad.blocks], 'zero-length'],
      [[...bad.blocks, ...repeated], 'client-blocks'],
      [[...repeated, ...bad.blocks], 'client-blocks'],
    ] as Array<[StructBlock[], string]>) {
      expectRefused(s, s.conn(`m${n++}`), encodeStructs(blocks, bad.ds), REFUSED(rule));
    }
    const lines = s.logs.filter((l) => l.startsWith('COLLAB_UPDATE_REFUSED ')).map((l) => JSON.parse(l.slice(l.indexOf('{'))));
    expect(lines.map((l) => [l.rule, l.mode])).toEqual([
      ['zero-length', 'report'],
      ['client-blocks', 'report'],
      ['zero-length', 'report'],
      ['zero-length', 'report'],
      ['client-blocks', 'report'],
      ['client-blocks', 'report'],
    ]);
    // the other way: a content rule still only logs in report mode (the frame applies), and so does an honest frame
    expect(s.send(s.conn('w'), encodeStructs(bad.blocks, bad.ds))).toBe('applied');
    expect(s.logs.some((l) => l.includes('"rule":"unknown-mark"') && l.includes('"mode":"report"'))).toBe(true);
    expect(s.send(s.conn('honest'), encodeStructs([{ client: X, clock: 0, structs: [at('ok')] }]))).toBe('applied');
  });
});

describe('#816 wire rules: keyed items carry no rightOrigin, delete ranges ascend', () => {
  it('a keyed item with a rightOrigin is refused attr-kind (control: Yjs integrates it as the key\'s value history)', () => {
    const s = setup({ seed: SEED });
    const author = new RemoteClient(s.live, 31);
    expect(s.send(s.conn('a'), author.edit(s.live, (f) => (f.get(0) as Y.XmlElement).setAttribute('textAlign', 'left')))).toBe('applied');
    const p = find(s.live, 'paragraph');
    const value = (p as any)._map.get('textAlign') as Y.Item;
    // origin none, rightOrigin the current value: the wire carries no key at all; Yjs takes it from the rightOrigin
    const attack = rawUpdate([{ client: 77, clock: 0, structs: [{ origin: null, right: [value.id.client, value.id.clock], content: new Y.ContentAny(['center']) }] }]);
    expect(Y.decodeUpdate(attack).structs[0]).toMatchObject({ parentSub: null }); // why the pre-pass cannot see it
    const control = unguarded(s.live, attack);
    const landed = Y.getItem(control.store, Y.createID(77, 0)) as Y.Item;
    expect(landed).toMatchObject({ parentSub: 'textAlign' });
    expect(landed.rightOrigin).not.toBeNull();
    expectRefused(s, s.conn('attacker'), attack, REFUSED('attr-kind'));
  });

  it('honest keyed writes never carry one: repeated and concurrent sets, undo and redo', () => {
    const s = setup({ seed: SEED });
    const one = new RemoteClient(s.live, 41);
    const two = new RemoteClient(s.live, 42);
    const undo = new Y.UndoManager(one.fragment, { captureTimeout: 0 });
    const sent: string[] = [];
    for (const v of ['left', 'center', 'right']) sent.push(s.send(s.conn('one'), one.edit(s.live, (f) => (f.get(0) as Y.XmlElement).setAttribute('textAlign', v))));
    const u1 = one.edit(s.live, (f) => (f.get(0) as Y.XmlElement).setAttribute('textAlign', 'left'));
    const u2 = two.edit(s.live, (f) => (f.get(0) as Y.XmlElement).setAttribute('textAlign', 'center'));
    sent.push(s.send(s.conn('one'), u1), s.send(s.conn('two'), u2));
    one.sync(s.live);
    const align = () => find(s.live, 'paragraph').getAttribute('textAlign');
    const seen = [align()];
    for (const op of [() => undo.undo(), () => undo.undo(), () => undo.redo(), () => undo.redo()]) {
      const sv = Y.encodeStateVector(s.live);
      op();
      sent.push(s.send(s.conn('one'), Y.encodeStateAsUpdate(one.doc, sv)));
      seen.push(align());
    }
    expect(sent.every((r) => r === 'applied')).toBe(true);
    expect(new Set(seen).size).toBeGreaterThan(1); // the undo and redo really rewrote the key
    for (const structs of s.live.store.clients.values()) {
      for (const st of structs) if (st instanceof Y.Item && st.parentSub !== null) expect(st.rightOrigin).toBeNull();
    }
  });

  it('delete ranges out of order are refused delete-order before any shadow work; Yjs\'s own sets pass', () => {
    const s = setup({ seed: SEED });
    const t = textOf(find(s.live, 'paragraph'));
    const at = ((t as any)._start as Y.Item).id;
    const ranges = (r: Array<[number, number]>) => rawUpdate([], [{ client: at.client, ranges: r.map(([o, l]) => [at.clock + o, l]) }]);
    // control: Yjs applies a falling set as given (it never sorts what it reads)
    expect(Y.decodeUpdate(ranges([[8, 1], [5, 1], [2, 1]])).ds.clients.get(at.client)!.map((d) => d.clock - at.clock)).toEqual([8, 5, 2]);
    expect(textOf(find(unguarded(s.live, ranges([[8, 1], [5, 1], [2, 1]])), 'paragraph')).toString()).toBe('viti txt');
    for (const bad of [[[8, 1], [5, 1], [2, 1]], [[2, 3], [4, 1]], [[2, 1], [2, 1]]] as Array<Array<[number, number]>>) {
      expectRefused(s, s.conn('attacker'), ranges(bad), REFUSED('delete-order'));
    }
    expect(s.guard.shadowOf(s.live)).toBeNull(); // refused by the pre-pass: no shadow built for it
    // honest: one transaction deleting in falling order, and a merge of such updates in reverse order
    const c = new RemoteClient(s.live);
    const edits: Uint8Array[] = [];
    c.doc.on('update', (u: Uint8Array) => edits.push(u));
    c.doc.transact(() => {
      const ct = textOf(c.fragment.get(0) as Y.XmlElement);
      ct.delete(8, 1);
      ct.delete(5, 1);
      ct.delete(2, 1);
    });
    c.doc.transact(() => textOf(c.fragment.get(0) as Y.XmlElement).delete(0, 1));
    expect(s.send(s.conn('honest'), Y.mergeUpdates(edits.slice().reverse()))).toBe('applied');
    expect(s.send(s.conn('honest'), ranges([[2, 1], [3, 1], [6, 2]]))).toBe('applied'); // adjacent ranges are ascending
  });
});

describe('#816 client ids new to the page: a ceiling per frame and the (user, document) id budget', () => {
  const ids = (s: ReturnType<typeof setup>, from: number, n: number) => {
    const at = ((textOf(find(s.live, 'paragraph')) as any)._start as Y.Item).id;
    return siblingsFrame(from, n, at.clock, at.client); // n ids, one character each, at the same place
  };

  it(`more than ${NEW_CLIENT_IDS_PER_FRAME} in one frame is refused client-ids before any shadow work; ${NEW_CLIENT_IDS_PER_FRAME} pass`, () => {
    expect(NEW_CLIENT_IDS_PER_FRAME).toBeLessThanOrEqual(AWARENESS_NEW_IDS_BURST); // so a frame under it never loops on 1013
    const s = setup({ seed: SEED });
    expectRefused(s, s.conn('attacker'), ids(s, 5000, NEW_CLIENT_IDS_PER_FRAME + 1), REFUSED('client-ids'));
    expect(s.guard.shadowOf(s.live)).toBeNull();
    expect(s.send(s.conn('editor'), ids(s, 6000, NEW_CLIENT_IDS_PER_FRAME))).toBe('applied');
  });

  it('they are charged to the per-(user, document) id budget: exhausted, the socket closes 1013; refilled, they pass', () => {
    let t = 1_000_000;
    const s = setup({ seed: SEED, now: () => t });
    expect(s.send(s.conn('a'), ids(s, 5000, 40))).toBe('applied');
    expect(s.send(s.conn('a'), ids(s, 6000, 40))).toBe(TRY_LATER);
    expect(s.limitLogs.some((l) => l.includes('"limit":"user_client_ids"'))).toBe(true);
    expect(s.send(s.conn('b'), ids(s, 7000, 40))).toBe('applied'); // per user
    expect(s.send(s.conn('a'), ids(s, 5000, 40), SYNC.Step2)).toBe('applied'); // ids live already holds are free
    t += 40 * AWARENESS_NEW_IDS_REFILL_MS;
    expect(s.send(s.conn('a'), ids(s, 6000, 40))).toBe('applied');
  });

  it('an id is paid for once, whichever announces it first: awareness, then structs, and structs, then awareness', () => {
    const s = setup({ seed: SEED, now: () => 1 });
    const meta = new Map<number, { clock: number }>();
    (s.live as unknown as { awareness: unknown }).awareness = { meta };
    const c = s.conn('a');
    const announce = (from: number) => awarenessFrame(Array.from({ length: AWARENESS_NEW_IDS_BURST / 2 }, (_, i) => ({ clientID: from + i, state: {} })));
    // awareness first (the whole burst's first half), then the structs of those ids on the same connection
    expect(s.deliver(c, announce(5000))).toBe('applied');
    expect(s.send(c, ids(s, 5000, AWARENESS_NEW_IDS_BURST / 2))).toBe('applied');
    // structs first (the second half), then awareness for those ids on the same connection
    expect(s.send(c, ids(s, 6000, AWARENESS_NEW_IDS_BURST / 2))).toBe('applied');
    expect(s.deliver(c, announce(6000))).toBe('applied');
    // an id the document's awareness holds (another connection announced it) is not charged either
    for (let i = 0; i < AWARENESS_NEW_IDS_BURST / 2; i++) meta.set(7000 + i, { clock: 1 });
    expect(s.send(s.conn('a'), ids(s, 7000, AWARENESS_NEW_IDS_BURST / 2))).toBe('applied');
    // the burst is spent now: one more new id waits
    expect(s.send(s.conn('a'), ids(s, 8000, 1))).toBe(TRY_LATER);
  });
});

describe('#816 the per-user collab CPU budget (a debt)', () => {
  /**
   * A fake CPU clock: the shadow's applies advance it by `apply` per frame and `rebuild` per rebuild, the pre-pass's
   * decode by `decode`. With `shared` it is the wall clock too, as in production: a synchronous apply blocks the event
   * loop, so wall time passes with it.
   */
  function cpuSetup(opts: { mode?: CollabGuardMode; shared?: boolean } = {}) {
    let t = 1_000_000;
    const cpu: { now: number; apply: number; rebuild: number; decode: number; live?: number } = { now: 0, apply: 0, rebuild: 0, decode: 0 };
    const spend = (ms: number) => {
      cpu.now += ms;
      if (opts.shared) t += ms;
    };
    const s = setup({ seed: SEED, now: () => t, cpuNow: () => cpu.now, mode: opts.mode });
    const real = Y.applyUpdate;
    const spy = jest.spyOn(Y, 'applyUpdate').mockImplementation((doc: Y.Doc, update: Uint8Array, origin?: unknown) => {
      const what = typeof origin === 'symbol' ? origin.description : undefined;
      if (what === 'ccc-collab-inspect') spend(cpu.apply);
      else if (doc === s.live && (origin as { source?: unknown } | undefined)?.source === 'connection') {
        // #840: live's own apply, timed on live (inside its transaction, as the registry times it)
        return Y.transact(doc, () => {
          spend(cpu.live ?? cpu.apply);
          real(doc, update, origin);
        }, origin, false);
      }
      else if (what === 'ccc-collab-mirror' && doc !== s.guard.shadowOf(s.live)) spend(cpu.rebuild); // a new shadow
      return real(doc, update, origin);
    });
    const realDecode = Y.decodeUpdate;
    jest.spyOn(Y, 'decodeUpdate').mockImplementation((update: Uint8Array) => {
      spend(cpu.decode);
      return realDecode(update);
    });
    const edit = () => new RemoteClient(s.live).edit(s.live, (f) => textOf(f.get(0) as Y.XmlElement).insert(0, 'x'));
    return { s, cpu, spy, edit, advance: (ms: number) => (t += ms), wall: () => t };
  }
  /** A frame the shadow step refuses (an object image src), which leaves the shadow dirty. */
  const badImage = (s: ReturnType<typeof setup>, n: number) =>
    new RemoteClient(s.live).edit(s.live, (f) => {
      const img = new Y.XmlElement('image');
      img.setAttribute('src', { evil: n } as never);
      f.insert(1, [img]);
    });
  afterEach(() => jest.restoreAllMocks());

  it('one large frame passes; a frame that arrives while the balance is negative waits (1013); the refill restores it', () => {
    const { s, cpu, edit, advance } = cpuSetup();
    cpu.apply = 1_500; // charged in full, 2 x 1500, from a burst of 2000: balance -1000
    expect(s.send(s.conn('a'), edit())).toBe('applied');
    expect(s.guard.cpuBalance('a')).toBe(USER_COLLAB_CPU_BURST_MS - 3_000);
    cpu.apply = 1;
    expect(s.send(s.conn('a'), edit())).toBe(TRY_LATER);
    expect(s.limitLogs.some((l) => l.includes('"limit":"user_collab_cpu"'))).toBe(true);
    expect(s.send(s.conn('b'), edit())).toBe('applied'); // per user
    const refill = (1_000 / USER_COLLAB_CPU_REFILL_MS_PER_SECOND) * 1_000; // wall ms that pay back 1000 ms of debt
    advance(refill - 1_000);
    expect(s.send(s.conn('a'), edit())).toBe(TRY_LATER); // still in debt
    advance(1_000);
    expect(s.send(s.conn('a'), edit())).toBe('applied'); // balance 0 is not negative
  });

  it.each([1_700, 10_000, 15_800])(
    'frames of %i ms each, on one clock for wall and CPU, hold their sender near a tenth of the event loop',
    (ms) => {
      // A charge clamped to the burst, or a refill earned while the frame itself ran, let frames of 10 s and more run
      // back to back: the sender held the event loop the whole hour.
      const { s, cpu, edit, advance, wall } = cpuSetup({ shared: true });
      expect(s.send(s.conn('warm'), edit())).toBe('applied'); // the shadow exists
      cpu.apply = ms;
      const start = wall();
      let busy = 0;
      let frame = edit();
      while (wall() - start < 3_600_000) {
        const before = s.guard.cpuBalance('a');
        if (s.send(s.conn('a'), frame) === TRY_LATER) {
          advance(1_000); // the provider's reconnect
          continue;
        }
        expect(s.guard.cpuBalance('a')).toBeCloseTo(before - 2 * ms, 6); // all of it, and no refill while it ran
        advance(ms); // live applies it again
        busy += 2 * ms;
        frame = edit();
      }
      const share = busy / (wall() - start);
      expect(share).toBeGreaterThan(0.05); // frames ran
      expect(share).toBeLessThan(0.12);
    },
  );

  it('a frame refused in the pre-pass is charged too: refused decodes alone end in 1013', () => {
    const { s, cpu } = cpuSetup();
    cpu.decode = 600;
    const unordered = rawUpdate([], [{ client: 7, ranges: [[5, 1], [2, 1]] }]); // delete ranges descending
    const results = Array.from({ length: 5 }, () => s.send(s.conn('a'), unordered));
    expect(results).toEqual([...Array(4).fill(REFUSED('delete-order')), TRY_LATER]); // 4 x 600 > the 2000 burst
  });

  it('a user alone whose frames are refused in the shadow pays for each one and for the rebuild it leaves', () => {
    const { s, cpu } = cpuSetup();
    cpu.apply = 300;
    cpu.rebuild = 400;
    // each frame: a rebuild (the first build, then the one its own last refusal left) once, the apply twice = 1000
    const results = Array.from({ length: 4 }, (_, n) => s.send(s.conn('a'), badImage(s, n)));
    expect(results.slice(0, 3).every((r) => r !== 'applied' && r !== TRY_LATER)).toBe(true);
    expect(results[3]).toBe(TRY_LATER); // 2000 - 1000 - 1000 = 0 still runs; -1000 waits
  });

  it('a rebuild a refusal made necessary is charged to the refused user, never to the co-editor who triggers it', () => {
    const { s, cpu, edit } = cpuSetup();
    cpu.apply = 1;
    cpu.rebuild = 200; // small enough that several rounds rebuild before the refused user is in debt
    const results: string[] = [];
    const attacker: string[] = [];
    const rounds = 10;
    for (let round = 0; round < rounds; round++) {
      attacker.push(s.send(s.conn('attacker'), badImage(s, round)));
      results.push(s.send(s.conn('co-editor'), edit())); // after each refusal, rebuilds the shadow
    }
    expect(results.every((r) => r === 'applied')).toBe(true);
    const refusedInShadow = attacker.filter((r) => r !== TRY_LATER && r !== 'applied').length;
    expect(refusedInShadow).toBeGreaterThanOrEqual(3); // the co-editor rebuilt after each of these
    expect(attacker[rounds - 1]).toBe(TRY_LATER); // the rebuilds were the attacker's
    expect(s.guard.cpuBalance('co-editor')).toBe(USER_COLLAB_CPU_BURST_MS - rounds * 2 * cpu.apply); // its own applies only
  });

  it('report mode only logs', () => {
    const { s, cpu, edit } = cpuSetup({ mode: 'report' });
    cpu.apply = 1_500;
    for (let i = 0; i < 4; i++) expect(s.send(s.conn('a'), edit())).toBe('applied');
    expect(s.limitLogs.some((l) => l.includes('"limit":"user_collab_cpu"'))).toBe(true);
  });
});
