/**
 * CCC authorization integration — NOT upstream Docmost code (#781, ADR 0036).
 *
 * The collab update guard: refuses, BEFORE Hocuspocus applies it, a client frame that would make any browser's
 * y-tiptap delete content (its delete-on-error syncs to every peer), crash a render, or wedge the server's store; binds
 * each Yjs client id to the user who first used it; and keeps clients out of every root but `'default'` (the `/v1`
 * idempotency ledger, `__ccc_write_idem`, is server-only) and out of Stateless broadcasts.
 *
 * How: each live Document gets a SHADOW replica (a second Y.Doc kept equal to live by a mirror listener). A frame is
 * applied to the shadow inside `Y.transact(shadow, …, origin, local=false)` — what y-protocols does to live — and
 * inspected inside that transaction, before Yjs's cleanup garbage-collects or merges anything: every struct from the
 * transaction's `beforeState` to the store's end, plus `tr.deleteSet`. So Yjs itself resolves parents, origins, splits
 * and pending structs. A refused frame leaves the shadow ahead of live, so the shadow is rebuilt from live plus the
 * frames accepted but not yet applied (`inflight`), keeping it an exact image of live's future.
 *
 * Ordering (Hocuspocus 3.4.4): `beforeHandleMessage` hooks run as one promise chain per frame; the frame applies when
 * its chain resolves. Frames apply in arrival order only while every chain has the same length, so this guard is
 * synchronous (returns undefined or throws, never a promise), runs first, and is the only such hook
 * (collab-update-guard.wiring.spec.ts). Accepted frames have applied by the next macrotask: `setImmediate` clears the
 * in-flight list. Hocuspocus 3.4.4 also applies frames that were already in its chain when it CLOSEs a refused
 * connection, so a refused connection's later frames are refused here too.
 *
 * Refusal = a throw of `{ code: 4422, reason }`: Hocuspocus closes that ONE document session and sends the reason (the
 * websocket stays up). Reasons the client acts on (apps/client features/editor-ux): `ccc:collab-update-refused:<rule>`
 * (stop sending, read-only, notice) and `ccc:collab-update-unresolved` (reconnect once). A socket whose sessions are
 * refused SOCKET_REFUSAL_BUDGET times is closed outright. `COLLAB_UPDATE_GUARD=report` logs instead of refusing.
 */
import { Logger } from '@nestjs/common';
import * as decoding from 'lib0/decoding';
import * as Y from 'yjs';
import {
  checkAttribute,
  checkElement,
  checkFormat,
  checkValue,
  checkYTable,
  COLLAB_LIMITS,
  isElementName,
  type CollabRule,
  type ElementCheck,
  type Violation,
} from './content-rules';

export type CollabGuardMode = 'enforce' | 'report';
/** Kill switch, read once at load (like write-idem.ts): anything but `report` enforces. */
export const COLLAB_UPDATE_GUARD_MODE: CollabGuardMode = process.env.COLLAB_UPDATE_GUARD?.trim() === 'report' ? 'report' : 'enforce';
export const COLLAB_REFUSAL_CODE = 4422;
export const REFUSED_REASON_PREFIX = 'ccc:collab-update-refused:';
export const UNRESOLVED_REASON = 'ccc:collab-update-unresolved';
export const SOCKET_REFUSAL_BUDGET = 3;
/** An honest connection announces one client id (two after Yjs regenerates one); this only bounds memory. */
const AWARENESS_BINDS_PER_CONNECTION = 32;
const LOGS_PER_MINUTE = 30;

export const reasonFor = (rule: CollabRule): string => (rule === 'unresolved' ? UNRESOLVED_REASON : REFUSED_REASON_PREFIX + rule);

/** Hocuspocus 3.4.4 MessageType values and y-protocols sync subtypes. */
const MESSAGE = { Sync: 0, Awareness: 1, SyncReply: 4, Stateless: 5, BroadcastStateless: 6 } as const;
const STEP2 = 1;
const UPDATE = 2;
/** The binding owner of the server's own client ids (live's, the shadow's): never a user id. */
const SERVER = '\u0000server';
const MIRROR = Symbol('ccc-collab-mirror');
const INSPECT = Symbol('ccc-collab-inspect');

export interface GuardLogger {
  warn(message: string): void;
}
export interface GuardConnection {
  readOnly: boolean;
  webSocket?: { close(code?: number, reason?: string): void };
}
/** The subset of Hocuspocus's `beforeHandleMessagePayload` the guard reads. */
export interface GuardFrame {
  connection: GuardConnection;
  /** Hocuspocus's Document: a Y.Doc with its page name and the awareness it has applied (`meta`: clientID → clock). */
  document: Y.Doc & { name?: string; awareness?: { meta: Map<number, { clock: number }> } };
  update: Uint8Array;
  context?: { user?: { id?: string } };
}
type Header = { type: number; subtype?: number; payload?: Uint8Array | null };
type ShadowResult = { violation: Violation | null; binds: Map<number, string>; applied: boolean };
type Ranges = Map<number, Array<[number, number]>>;

/** Per live Document: its shadow, client-id bindings and audit results. Dropped with the document (`destroy`). */
class DocGuard {
  shadow: Y.Doc | null = null;
  dirty = false;
  unavailable = false;
  audited = false;
  readonly bindings = new Map<number, string>();
  /** Elements the first build found invalid (legacy rows): reported, not refused. Ids survive rebuilds. */
  readonly legacyInvalid = new Set<string>();
  /** Pending structs the document was loaded with: a frame that releases them is not blamed for them. */
  legacyPending: Ranges = new Map();
  readonly inflight: Uint8Array[] = [];
  flushScheduled = false;
  readonly awarenessBinds = new WeakMap<object, number>();
  constructor(readonly live: Y.Doc & { name?: string }) {}
}

export class CollabUpdateGuard {
  private readonly docs = new WeakMap<Y.Doc, DocGuard>();
  private readonly refusedConnections = new WeakMap<object, string>();
  private readonly socketRefusals = new WeakMap<object, number>();
  private readonly mode: CollabGuardMode;
  private readonly logger: GuardLogger;
  private logWindow = { start: 0, count: 0, suppressed: 0 };

  constructor(opts: { mode?: CollabGuardMode; logger?: GuardLogger } = {}) {
    this.mode = opts.mode ?? COLLAB_UPDATE_GUARD_MODE;
    this.logger = opts.logger ?? new Logger('CollabUpdateGuard');
  }

  /** Synchronous: returns undefined (apply the frame) or throws `{ code, reason }` (refuse it). Never a promise. */
  check(frame: GuardFrame): void {
    const earlier = this.refusedConnections.get(frame.connection);
    if (earlier) throw { code: COLLAB_REFUSAL_CODE, reason: earlier };
    const header = readHeader(frame.update);
    if (!header) return; // not decodable as a frame: Hocuspocus refuses it itself
    if (header.type === MESSAGE.Stateless || header.type === MESSAGE.BroadcastStateless) {
      return this.refuse(frame, header, { rule: 'stateless' }); // nothing in Docmost sends one; a broadcast reaches every peer
    }
    if (header.type === MESSAGE.Awareness) {
      // Hocuspocus relays a reader's awareness too, so only a writer's binds: a reader could otherwise claim a writer's id.
      if (!frame.connection.readOnly && header.payload) this.bindFromAwareness(this.docFor(frame.document), frame, header.payload);
      return;
    }
    if (header.type !== MESSAGE.Sync && header.type !== MESSAGE.SyncReply) return;
    if (header.subtype !== STEP2 && header.subtype !== UPDATE) return; // Step1 applies nothing
    if (frame.connection.readOnly) return; // Hocuspocus never applies a read-only connection's update
    if (!header.payload) return this.refuse(frame, header, { rule: 'undecodable' });
    this.inspect(frame, header, header.payload);
  }

  /** The shadow replica of `live` (specs and diagnostics). */
  shadowOf(live: Y.Doc): Y.Doc | null {
    return this.docs.get(live)?.shadow ?? null;
  }

  private inspect(frame: GuardFrame, header: Header, payload: Uint8Array): void {
    const doc = this.docFor(frame.document);
    const userId = String(frame.context?.user?.id ?? '');
    // 1. Stateless pre-pass: a refusal here touches no shadow, so a refuse/reconnect loop costs no rebuild.
    let violation = prePass(payload);
    if (violation && this.mode === 'enforce') return this.refuse(frame, header, violation);
    // 2. The shadow step.
    if (!this.ensureShadow(doc)) return this.refuse(frame, header, violation ?? { rule: 'shadow-unavailable' });
    const result = this.applyToShadow(doc, payload, userId);
    violation ??= result.violation;
    if (violation && this.mode === 'enforce') {
      this.rebuild(doc); // the shadow holds the refused frame; live never will
      return this.refuse(frame, header, violation);
    }
    if (violation) this.refuse(frame, header, violation); // report mode: logged, and the frame applies
    for (const [client, user] of result.binds) if (!doc.bindings.has(client)) doc.bindings.set(client, user);
    // A frame the shadow could not apply is not replayed into a rebuild (it would fail every rebuild from then on).
    if (result.applied) doc.inflight.push(payload.slice());
    this.scheduleFlush(doc);
  }

  private applyToShadow(doc: DocGuard, payload: Uint8Array, userId: string): ShadowResult {
    const shadow = doc.shadow!;
    const pendingBefore = pendingRanges(shadow.store);
    let out: ShadowResult = { violation: { rule: 'internal' }, binds: new Map(), applied: false };
    try {
      Y.transact(
        shadow,
        (tr) => {
          Y.applyUpdate(shadow, payload, INSPECT); // V1, as y-protocols reads Step2 and Update
          out = this.inspectTransaction(doc, tr, userId, pendingBefore);
        },
        INSPECT,
        false,
      );
    } catch {
      doc.dirty = true;
      return { violation: { rule: 'internal' }, binds: new Map(), applied: false };
    }
    return out;
  }

  /** Inside the transaction, after the frame integrated and before any GC or merge. */
  private inspectTransaction(doc: DocGuard, tr: Y.Transaction, userId: string, pendingBefore: Ranges) {
    const shadow = tr.doc;
    const store = shadow.store;
    const root = shadow.share.get('default');
    const touched = new Set<Y.AbstractType<any>>();
    const newTypes: Y.AbstractType<any>[] = [];
    const binds = new Map<number, string>();
    const reportOnly: Violation[] = [];
    const result = (violation: Violation | null): ShadowResult => ({ violation, binds, applied: true });

    for (const [client, structs] of store.clients) {
      const before = tr.beforeState.get(client) ?? 0;
      if (Y.getState(store, client) <= before) continue;
      for (let i = Y.findIndexSS(structs, before); i < structs.length; i++) {
        const struct = structs[i];
        const legacy = inRanges(doc.legacyPending, client, struct.id.clock, struct.length);
        if (!legacy) {
          // Client-id binding, on NEW clocks only: a remount honestly resends a peer's structs live already has.
          const owner = doc.bindings.get(client) ?? binds.get(client);
          if (owner === undefined) {
            // Only an id live never saw binds here. An id the stored document already holds (an earlier lifetime) binds
            // by awareness only: bindings are not persisted, so a claim on it after a reload is undetectable (ADR 0036).
            if (!tr.beforeState.has(client)) binds.set(client, userId);
          } else if (owner !== userId) {
            return result({ rule: 'foreign-client' });
          }
        }
        if (!(struct instanceof Y.Item)) continue; // GC: no content, no parent
        const v = checkStruct(struct, root, touched, newTypes);
        if (v && legacy) reportOnly.push(v);
        else if (v) return result(v);
      }
    }
    for (const type of newTypes) if (depthOf(type) > COLLAB_LIMITS.elementDepth) return result({ rule: 'element-depth' });

    let deletion: Violation | null = null;
    Y.iterateDeletedStructs(tr, tr.deleteSet, (struct) => {
      if (deletion || !(struct instanceof Y.Item)) return;
      if (rootOf(struct.parent as Y.AbstractType<any>) !== root) {
        deletion = { rule: 'root' };
        return;
      }
      touch(struct, touched);
    });
    if (deletion) return result(deletion);

    for (const type of touched) {
      if (type !== root && kindOf(type) !== 'element') continue;
      if (!isVisible(type)) continue;
      const check = checkElement(type as Y.XmlElement);
      if (check.ok || check.empty) continue; // an emptied container loses nothing (see content-rules.ts)
      if (doc.legacyInvalid.has(idOf(type))) continue; // invalid before this frame, already deleted on every open
      return result(check.violation);
    }
    // A table's extent is a property of the whole table: a changed cell span, row or cell can widen it.
    const tables = new Set<Y.XmlElement>();
    for (const type of touched) {
      const table = enclosingTable(type);
      if (table && isVisible(table) && !doc.legacyInvalid.has(idOf(table))) tables.add(table);
    }
    for (const table of tables) {
      const v = checkYTable(table);
      if (v) return result(v);
    }
    // Structs that wait for a missing dependency would integrate later, unchecked and blamed on whoever sends it.
    if (!covers(pendingBefore, pendingRanges(store))) return result({ rule: 'unresolved' });
    for (const v of reportOnly) this.log('COLLAB_LEGACY_PENDING_INVALID', doc.live, { rule: v.rule });
    return result(null);
  }

  private docFor(live: Y.Doc & { name?: string }): DocGuard {
    const known = this.docs.get(live);
    if (known) return known;
    const created = new DocGuard(live);
    created.bindings.set(live.clientID, SERVER);
    // The mirror NEVER throws: a throw in a Yjs 'update' listener stops every later listener and wedges the document's
    // cleanup for good. On any failure the shadow is only marked dirty (the next frame rebuilds it).
    const mirror = (update: Uint8Array) => {
      const shadow = created.shadow;
      if (!shadow || created.dirty) return;
      try {
        Y.applyUpdate(shadow, update, MIRROR);
      } catch {
        created.dirty = true;
      }
    };
    live.on('update', mirror);
    live.once('destroy', () => {
      live.off('update', mirror);
      created.shadow = null;
      this.docs.delete(live);
    });
    this.docs.set(live, created);
    return created;
  }

  private ensureShadow(doc: DocGuard): boolean {
    if (doc.unavailable) return false;
    if (doc.shadow && !doc.dirty && statesCover(doc.shadow.store, doc.live.store)) return true;
    return this.rebuild(doc);
  }

  /** The shadow from live plus the frames accepted but not yet applied: exactly what live will hold. */
  private rebuild(doc: DocGuard): boolean {
    if (doc.unavailable) return false;
    const live = doc.live;
    try {
      const shadow = new Y.Doc({ gc: live.gc, gcFilter: live.gcFilter });
      shadow.getXmlFragment('default');
      Y.applyUpdate(shadow, Y.encodeStateAsUpdate(live), MIRROR);
      for (const frame of doc.inflight) Y.applyUpdate(shadow, frame, MIRROR);
      doc.shadow = shadow;
      doc.dirty = false;
      if (!doc.bindings.has(shadow.clientID)) doc.bindings.set(shadow.clientID, SERVER);
      if (!doc.audited) this.audit(doc, shadow);
      return true;
    } catch {
      // A live document Yjs cannot encode (a legacy value too deep for lib0's encoder): fail closed, logged once.
      doc.unavailable = true;
      doc.shadow = null;
      this.logger.warn(`COLLAB_SHADOW_UNAVAILABLE ${JSON.stringify({ pageId: pageIdOf(live) })}`);
      return false;
    }
  }

  /** First build only: a report-only audit of the stored content (legacy rows), at no extra cost. */
  private audit(doc: DocGuard, shadow: Y.Doc): void {
    doc.audited = true;
    doc.legacyPending = pendingRanges(shadow.store);
    const rules: Record<string, number> = {};
    const root = shadow.getXmlFragment('default');
    /** Elements every browser's y-tiptap deletes on open (invalid, or emptied and then invalid). */
    const gone = new Set<Y.AbstractType<any>>();
    const stack: Array<[Y.AbstractType<any>, number]> = [[root, 0]];
    while (stack.length) {
      const [type, depth] = stack.pop()!;
      const check: ElementCheck = depth > COLLAB_LIMITS.elementDepth ? { ok: false, violation: { rule: 'element-depth' }, empty: false } : checkElement(type as Y.XmlElement);
      if (!check.ok && type !== root) gone.add(type);
      const tableSize = type !== root && (type as Y.XmlElement).nodeName === 'table' ? checkYTable(type as Y.XmlElement) : null;
      if (tableSize && check.ok) {
        doc.legacyInvalid.add(idOf(type)); // a legacy table past the extent bound: reported, its edits not refused for it
        rules['table-size'] = (rules['table-size'] ?? 0) + 1;
      }
      if (!check.ok && !check.empty) {
        doc.legacyInvalid.add(idOf(type));
        rules[check.violation.rule] = (rules[check.violation.rule] ?? 0) + 1;
      }
      for (let item = type._start; item !== null; item = item.right) {
        if (!item.deleted && item.content instanceof Y.ContentType && kindOf(item.content.type) === 'element') {
          stack.push([item.content.type, depth + 1]);
        }
      }
    }
    // y-tiptap's cascade: deleting an invalid element can leave its parent invalid, and every browser then deletes the
    // parent too, one transaction (one frame) per element. Each parent left invalid and non-empty is legacy as well, so
    // the deletes of every browser that opens the page are accepted, never refused on every open.
    const queue = [...gone];
    while (queue.length) {
      const parent = queue.pop()!._item?.parent as Y.AbstractType<any> | undefined;
      if (!parent || gone.has(parent) || !isVisible(parent)) continue;
      const check = checkElement(parent as Y.XmlElement, gone);
      if (check.ok) continue;
      if (!check.empty) {
        doc.legacyInvalid.add(idOf(parent));
        rules[`cascade:${check.violation!.rule}`] = (rules[`cascade:${check.violation!.rule}`] ?? 0) + 1;
      }
      if (parent !== root) {
        gone.add(parent);
        queue.push(parent);
      }
    }
    if (doc.legacyInvalid.size) {
      this.logger.warn(`COLLAB_STORED_CONTENT_INVALID ${JSON.stringify({ pageId: pageIdOf(doc.live), elements: doc.legacyInvalid.size, rules })}`);
    }
  }

  private scheduleFlush(doc: DocGuard): void {
    if (doc.flushScheduled) return;
    doc.flushScheduled = true;
    setImmediate(() => {
      doc.flushScheduled = false;
      doc.inflight.length = 0;
      // Every accepted frame has applied by now. A shadow still ahead of live means one did not: rebuild before trusting it.
      const shadow = doc.shadow;
      if (shadow && !statesCover(doc.live.store, shadow.store)) doc.dirty = true;
    });
  }

  private bindFromAwareness(doc: DocGuard, frame: GuardFrame, payload: Uint8Array): void {
    const userId = String(frame.context?.user?.id ?? '');
    try {
      const d = decoding.createDecoder(payload);
      const n = decoding.readVarUint(d);
      for (let i = 0; i < n; i++) {
        const clientID = decoding.readVarUint(d);
        const clock = decoding.readVarUint(d);
        const state = JSON.parse(decoding.readVarString(d));
        if (state === null || doc.bindings.has(clientID)) continue;
        // An echo: every provider sends the peer states it receives back to the server. The server already holds this
        // client's state at this clock (it relayed it), so the echo says nothing about who owns the id: a writer's echo
        // of a READER's state would otherwise bind the reader's id to the writer, refusing the reader once promoted.
        const held = frame.document.awareness?.meta.get(clientID)?.clock;
        if (held !== undefined && held >= clock) continue;
        const used = doc.awarenessBinds.get(frame.connection) ?? 0;
        if (used >= AWARENESS_BINDS_PER_CONNECTION) return;
        doc.bindings.set(clientID, userId);
        doc.awarenessBinds.set(frame.connection, used + 1);
      }
    } catch {
      // a malformed awareness frame: Hocuspocus refuses it itself
    }
  }

  /** Logs the refusal; in enforce mode also closes the session (throws) and counts against the socket's budget. */
  private refuse(frame: GuardFrame, header: Header, violation: Violation): void {
    const reason = reasonFor(violation.rule);
    this.log('COLLAB_UPDATE_REFUSED', frame.document, {
      rule: violation.rule,
      ...(violation.node ? { node: violation.node } : {}),
      ...(violation.mark ? { mark: violation.mark } : {}),
      ...(violation.key ? { key: violation.key } : {}),
      userId: frame.context?.user?.id,
      msgType: header.type,
      ...(header.subtype !== undefined ? { syncType: header.subtype } : {}),
      bytes: frame.update.length,
      mode: this.mode,
    });
    if (this.mode !== 'enforce') return;
    this.refusedConnections.set(frame.connection, reason);
    const ws = frame.connection.webSocket;
    if (ws) {
      const refusals = (this.socketRefusals.get(ws) ?? 0) + 1;
      this.socketRefusals.set(ws, refusals);
      if (refusals >= SOCKET_REFUSAL_BUDGET) {
        try {
          ws.close(COLLAB_REFUSAL_CODE, reason);
        } catch {
          // already closing
        }
      }
    }
    throw { code: COLLAB_REFUSAL_CODE, reason };
  }

  /** Rate-limited structured warn lines. Schema ids, user and page ids only: never a value or any content. */
  private log(token: string, live: Y.Doc & { name?: string }, fields: Record<string, unknown>): void {
    const now = Date.now();
    const w = this.logWindow;
    if (now - w.start >= 60_000) {
      if (w.suppressed) this.logger.warn(`COLLAB_GUARD_LOG_SUPPRESSED ${JSON.stringify({ count: w.suppressed })}`);
      this.logWindow = { start: now, count: 0, suppressed: 0 };
    }
    if (this.logWindow.count++ < LOGS_PER_MINUTE) this.logger.warn(`${token} ${JSON.stringify({ ...fields, pageId: pageIdOf(live) })}`);
    else this.logWindow.suppressed++;
  }
}

/** The frame header, decoded exactly as Hocuspocus's MessageReceiver does (one sync message per frame, V1). */
function readHeader(update: Uint8Array): Header | null {
  try {
    const d = decoding.createDecoder(update);
    decoding.readVarString(d);
    const type = decoding.readVarUint(d);
    if (type === MESSAGE.Sync || type === MESSAGE.SyncReply) {
      const subtype = decoding.readVarUint(d);
      if (subtype !== STEP2 && subtype !== UPDATE) return { type, subtype };
      return { type, subtype, payload: tryRead(() => decoding.readVarUint8Array(d)) };
    }
    if (type === MESSAGE.Awareness) return { type, payload: tryRead(() => decoding.readVarUint8Array(d)) };
    return { type };
  } catch {
    return null;
  }
}
const tryRead = (read: () => Uint8Array): Uint8Array | null => {
  try {
    return read();
  } catch {
    return null;
  }
};

/** The stateless rules, on the decoded frame (no document state, so already-known structs are checked too). */
function prePass(payload: Uint8Array): Violation | null {
  let structs: Array<Y.Item | Y.GC | Y.Skip>;
  try {
    structs = Y.decodeUpdate(payload).structs as Array<Y.Item | Y.GC | Y.Skip>;
  } catch {
    return { rule: 'undecodable' }; // e.g. a lib0 `readAny` value deep enough to overflow the decoder
  }
  for (const struct of structs) {
    if (!(struct instanceof Y.Item)) continue;
    const parent = struct.parent as unknown;
    if (typeof parent === 'string' && parent !== 'default') return { rule: 'root' };
    if (parent === 'default' && struct.parentSub !== null) return { rule: 'attr-kind' };
    if (struct.parentSub === '__proto__') return { rule: 'attr-kind' };
    const content = struct.content;
    if (content.getLength() === 0) return { rule: 'zero-length' };
    if (content instanceof Y.ContentString || content instanceof Y.ContentDeleted) continue;
    if (content instanceof Y.ContentAny) {
      for (const value of content.arr) {
        const rule = checkValue(value);
        if (rule) return { rule };
      }
      continue;
    }
    if (content instanceof Y.ContentFormat) {
      const v = checkFormat(content.key, content.value);
      if (v) return v;
      continue;
    }
    if (content instanceof Y.ContentType) {
      const type = content.type;
      if (type.constructor === Y.XmlText) continue;
      if (type.constructor === Y.XmlElement) {
        if (!isElementName((type as Y.XmlElement).nodeName)) return { rule: 'schema' }; // y-tiptap deletes it on every peer
        continue;
      }
    }
    return { rule: 'content-kind' }; // Embed, Binary, JSON, Doc (a subdocument), or a non-Xml shared type
  }
  return null;
}

/**
 * Root, kind and value rules for one struct the frame added, and what it touches: the element whose children or
 * attributes changed, the element owning a changed XmlText, and every element the frame created.
 */
function checkStruct(item: Y.Item, root: Y.AbstractType<any> | undefined, touched: Set<Y.AbstractType<any>>, newTypes: Y.AbstractType<any>[]): Violation | null {
  const parent = item.parent as Y.AbstractType<any>;
  const parentKind = kindOf(parent);
  if (rootOf(parent) !== root) return { rule: 'root' };
  if (item.deleted) return null; // ContentDeleted, or deleted on arrival: nothing of it is ever rendered or stored
  const content = item.content;
  if (item.parentSub !== null) {
    if (parentKind !== 'element' || !(content instanceof Y.ContentAny)) return { rule: content instanceof Y.ContentType ? 'content-kind' : 'attr-kind' };
    const v = checkAttribute((parent as Y.XmlElement).nodeName, item.parentSub, content.arr, { yjs: true });
    if (v) return v;
    touched.add(parent);
    return null;
  }
  if (parentKind === 'text') {
    if (content instanceof Y.ContentFormat) {
      const v = checkFormat(content.key, content.value);
      if (v) return v;
    } else if (!(content instanceof Y.ContentString)) {
      return { rule: 'text-kind' };
    }
    touched.add(parent._item!.parent as Y.AbstractType<any>);
    return null;
  }
  if (parent !== root && parentKind !== 'element') return { rule: 'child-kind' };
  if (!(content instanceof Y.ContentType)) return { rule: 'child-kind' };
  const type = content.type as Y.AbstractType<any>;
  const kind = kindOf(type);
  if (kind === 'element') touched.add(type);
  else if (kind !== 'text') return { rule: 'content-kind' };
  else if (parent === root) return { rule: 'child-kind' }; // any root XmlText stops the page opening (even if the root is legacy)
  newTypes.push(type);
  touched.add(parent);
  return null;
}

/** The table a touched table, row or cell belongs to (the structure its extent is computed from). */
function enclosingTable(type: Y.AbstractType<any>): Y.XmlElement | null {
  let t: Y.AbstractType<any> | null = type;
  for (let up = 0; up < 3 && t && kindOf(t) === 'element'; up++) {
    const name = (t as Y.XmlElement).nodeName;
    if (name === 'table') return t as Y.XmlElement;
    if (name !== 'tableRow' && name !== 'tableCell' && name !== 'tableHeader') return null;
    t = t._item ? (t._item.parent as Y.AbstractType<any>) : null;
  }
  return null;
}

/** A deleted struct touches the element whose children, attributes or text it changed. */
function touch(item: Y.Item, touched: Set<Y.AbstractType<any>>): void {
  const parent = item.parent as Y.AbstractType<any>;
  if (item.parentSub === null && kindOf(parent) === 'text') touched.add(parent._item!.parent as Y.AbstractType<any>);
  else touched.add(parent);
}

/** Exact Yjs type kinds (XmlHook extends Y.Map, XmlText extends Y.Text, XmlElement extends XmlFragment). */
function kindOf(type: unknown): 'element' | 'text' | 'other' {
  const ctor = (type as { constructor?: unknown } | null)?.constructor;
  return ctor === Y.XmlElement ? 'element' : ctor === Y.XmlText ? 'text' : 'other';
}

function rootOf(type: Y.AbstractType<any>): Y.AbstractType<any> {
  let t = type;
  while (t._item !== null) t = t._item.parent as Y.AbstractType<any>;
  return t;
}
function depthOf(type: Y.AbstractType<any>): number {
  let depth = 0;
  for (let t = type; t._item !== null && depth <= COLLAB_LIMITS.elementDepth; t = t._item.parent as Y.AbstractType<any>) depth++;
  return depth;
}
function isVisible(type: Y.AbstractType<any>): boolean {
  for (let t = type; t._item !== null; t = t._item.parent as Y.AbstractType<any>) if (t._item.deleted) return false;
  return true;
}
const idOf = (type: Y.AbstractType<any>): string => (type._item ? `${type._item.id.client}:${type._item.id.clock}` : 'root');
const pageIdOf = (live: { name?: string }): string | undefined => live.name?.replace(/^page\./, '');

/** Does store `a` hold every clock store `b` holds? */
function statesCover(a: Y.Doc['store'], b: Y.Doc['store']): boolean {
  for (const client of b.clients.keys()) if (Y.getState(a, client) < Y.getState(b, client)) return false;
  return true;
}

/** The ID ranges of a store's pending structs and pending deletes (both V2 updates). */
function pendingRanges(store: Y.Doc['store']): Ranges {
  const out: Ranges = new Map();
  const add = (client: number, start: number, end: number) => {
    if (!out.has(client)) out.set(client, []);
    out.get(client)!.push([start, end]);
  };
  if (store.pendingStructs) {
    for (const s of Y.decodeUpdateV2(store.pendingStructs.update).structs) add(s.id.client, s.id.clock, s.id.clock + s.length);
  }
  if (store.pendingDs) {
    for (const [client, items] of Y.decodeUpdateV2(store.pendingDs).ds.clients) for (const d of items) add(client, d.clock, d.clock + d.len);
  }
  return out;
}

/** Is every range of `inner` inside one range of `outer`? */
function covers(outer: Ranges, inner: Ranges): boolean {
  for (const [client, ranges] of inner) {
    const bounds = outer.get(client) ?? [];
    for (const [start, end] of ranges) if (end > start && !bounds.some(([s, e]) => s <= start && end <= e)) return false;
  }
  return true;
}
const inRanges = (ranges: Ranges, client: number, clock: number, length: number): boolean =>
  (ranges.get(client) ?? []).some(([s, e]) => s <= clock && clock + length <= e);
