import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { admitCollabFrame, isCollabFrameAddress } from './frame-admission';
import { MessageType } from '@hocuspocus/server';
import { AuthMessageType, WsReadyStates } from '@hocuspocus/common';
import { MSG } from './collab-ingress.testkit';
import {
  COLLAB_AUTH_FRAMES_PER_SOCKET,
  COLLAB_AWARENESS_BURST,
  COLLAB_AWARENESS_BURST_BYTES,
  COLLAB_AWARENESS_MIN_CHARGE_BYTES,
  COLLAB_AWARENESS_REFILL_BYTES_PER_SECOND,
  COLLAB_AWARENESS_REFILL_PER_SECOND,
  COLLAB_DOCUMENTS_PER_SOCKET,
  COLLAB_HOCUSPOCUS_OPTIONS,
  COLLAB_SOCKET_LIMIT_LOGS_PER_MINUTE,
} from './limits';
import { logCollabSocketError, SocketLimitLog } from './socket-limit-log';

/** #790: the gateway admits a frame only when its document name is `page.<uuid>`. */
const frameFor = (name: string, body: number[] = [0, 0, 0]): Uint8Array => {
  const e = encoding.createEncoder();
  encoding.writeVarString(e, name);
  for (const b of body) encoding.writeVarUint(e, b);
  return encoding.toUint8Array(e);
};
const V4 = '0f8fad5b-d9cb-469f-a165-70867728950e';
const V7 = '01890a5d-ac96-774b-bcce-b302099a8057';

describe('#790 isCollabFrameAddress', () => {
  it.each([
    ['uuid v4', `page.${V4}`],
    ['uuid v7', `page.${V7}`],
    ['the nil uuid', 'page.00000000-0000-0000-0000-000000000000'],
  ])('admits %s', (_label, name) => {
    const frame = frameFor(name);
    expect(isCollabFrameAddress(frame)).toBe(true);
    // the name admitted is exactly the name lib0 reads downstream (RedisSync, Hocuspocus)
    expect(decoding.readVarString(decoding.createDecoder(frame))).toBe(name);
  });

  it.each([
    ['junk', 'hello'],
    ['empty', ''],
    ['a non-page prefix', `space.${V4}`],
    ['a near-miss prefix', `pagex${V4}`],
    ['no prefix', V4.padEnd(41, '0')],
    ['a sessionId suffix', `page.${V4}\u0000session`],
    ['a trailing byte', `page.${V4}x`],
    ['a short uuid', `page.${V4.slice(0, -1)}`],
    ['a non-hex uuid', `page.${V4.replace('f', 'g')}`],
    ['a uuid without dashes, padded', `page.${V4.replace(/-/g, '')}xxxx`],
    ['a non-ASCII name of the right byte length', `page.${V4.slice(0, -2)}é`],
    ['a huge name', `page.${V4}`.repeat(200_000)],
    // Postgres compares uuids case-blind: an upper-case alias would load a second live document for the same page
    ['uuid v4, upper case', `page.${V4.toUpperCase()}`],
    ['uuid v7, upper case', `page.${V7.toUpperCase()}`],
    ['uuid v4, one upper-case hex digit', `page.${V4.replace('f', 'F')}`],
    ['an upper-case prefix', `PAGE.${V4}`],
  ])('refuses %s', (_label, name) => {
    expect(isCollabFrameAddress(frameFor(name))).toBe(false);
  });

  it('refuses frames too short to hold a name, and a non-minimal varint length', () => {
    expect(isCollabFrameAddress(new Uint8Array([]))).toBe(false);
    expect(isCollabFrameAddress(new Uint8Array([41]))).toBe(false);
    expect(isCollabFrameAddress(frameFor(`page.${V4}`).slice(0, 41))).toBe(false);
    // 41 written as two varint bytes (0xa9 0x00): lib0 reads 41, no lib0 encoder writes it
    const good = frameFor(`page.${V4}`);
    const padded = new Uint8Array([0xa9, 0x00, ...good.subarray(1)]);
    expect(decoding.readVarString(decoding.createDecoder(padded))).toBe(`page.${V4}`);
    expect(isCollabFrameAddress(padded)).toBe(false);
  });

  it('reads a frame inside a larger buffer (a ws Buffer slice) and an ArrayBuffer', () => {
    const good = frameFor(`page.${V4}`);
    const pool = new Uint8Array(good.byteLength + 16);
    pool.set([7, 7, 7, 7, 7, 7, 7, 7]);
    pool.set(good, 8);
    expect(isCollabFrameAddress(Buffer.from(pool.buffer, 8, good.byteLength))).toBe(true);
    expect(isCollabFrameAddress(good.slice().buffer)).toBe(true);
  });
});

describe('#790 admitCollabFrame (the gateway check)', () => {
  const socket = () => {
    const ws = { readyState: 1, terminate: jest.fn(() => (ws.readyState = 2)) };
    return ws;
  };
  const log = () => {
    const warn = jest.fn();
    return { warn, limitLog: new SocketLimitLog({ warn }) };
  };

  it('admits a page frame and leaves the socket alone', () => {
    const ws = socket();
    const { warn, limitLog } = log();
    expect(admitCollabFrame(ws, frameFor(`page.${V4}`), limitLog)).toBe(true);
    expect(ws.terminate).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('terminates on a junk name and logs one COLLAB_SOCKET_LIMIT line without the name', () => {
    const ws = socket();
    const { warn, limitLog } = log();
    const junk = frameFor('secret-junk-name');
    expect(admitCollabFrame(ws, junk, limitLog)).toBe(false);
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls).toEqual([[`COLLAB_SOCKET_LIMIT {"limit":"frame_address","frameBytes":${junk.byteLength}}`]]);
    expect(warn.mock.calls[0][0]).not.toContain('secret');
  });

  it('drops every frame once the socket is no longer open (frames already parsed after a termination)', () => {
    const ws = socket();
    const { warn, limitLog } = log();
    admitCollabFrame(ws, frameFor('junk'), limitLog);
    expect(admitCollabFrame(ws, frameFor(`page.${V4}`), limitLog)).toBe(false);
    expect(admitCollabFrame(ws, frameFor('junk'), limitLog)).toBe(false);
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('#790 logCollabSocketError (the collab module\'s ws client error listener)', () => {
  afterEach(() => jest.restoreAllMocks());

  afterEach(() => jest.useRealTimers());

  it(`logs ws\'s error code only, rate-limited: a client sending 1000 oversized frames writes ${COLLAB_SOCKET_LIMIT_LOGS_PER_MINUTE} lines`, () => {
    jest.useFakeTimers({ now: 7_000_000 });
    const warn = jest.fn();
    const limitLog = new SocketLimitLog({ warn });
    const err = Object.assign(new RangeError('Max payload size exceeded secret-bytes'), { code: 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' });
    for (let i = 0; i < 1000; i++) logCollabSocketError(err, limitLog);
    expect(warn).toHaveBeenCalledTimes(COLLAB_SOCKET_LIMIT_LOGS_PER_MINUTE);
    expect(warn.mock.calls[0][0]).toBe('COLLAB_SOCKET_LIMIT {"limit":"ws_error","code":"WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"}');
    expect(warn.mock.calls.join('')).not.toContain('secret');
  });

  it('an error with no code, or a code that is not a ws code, is logged as unknown', () => {
    const warn = jest.fn();
    const limitLog = new SocketLimitLog({ warn });
    logCollabSocketError(new Error('x'), limitLog);
    logCollabSocketError({ code: 'not a code {"json"}' }, limitLog);
    logCollabSocketError(null, limitLog);
    expect(warn.mock.calls.map((c) => c[0])).toEqual(Array(3).fill('COLLAB_SOCKET_LIMIT {"limit":"ws_error","code":"unknown"}'));
  });
});

describe('#790 SocketLimitLog', () => {
  afterEach(() => jest.restoreAllMocks());

  it(`logs at most ${COLLAB_SOCKET_LIMIT_LOGS_PER_MINUTE} lines of a limit a minute, then one line with that limit's suppressed count`, () => {
    let now = 1_000_000;
    const warn = jest.fn();
    const limitLog = new SocketLimitLog({ warn }, () => now);
    const quota = COLLAB_SOCKET_LIMIT_LOGS_PER_MINUTE;
    for (let i = 0; i < quota + 15; i++) limitLog.log('auth_rate', { userId: 'u1' });
    expect(warn).toHaveBeenCalledTimes(quota);
    now += 60_000;
    limitLog.log('auth_rate', { userId: 'u1' });
    expect(warn.mock.calls.slice(quota).map((c) => c[0])).toEqual([
      'COLLAB_SOCKET_LIMIT {"limit":"log_suppressed","of":"auth_rate","count":15}',
      'COLLAB_SOCKET_LIMIT {"limit":"auth_rate","userId":"u1"}',
    ]);
  });
});

/** A uuid-named page frame of message `type` (Auth = 2) with an optional raw type encoding. */
const pageN = (n: number) => `page.${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000790`;
const typed = (name: string, type: number) => frameFor(name, [type, 0, 0]);

describe('#790 admitCollabFrame: distinct documents per socket (before RedisSync claims a Redis lock per name)', () => {
  const socket = () => {
    const ws = { readyState: 1, terminate: jest.fn(() => (ws.readyState = 2)) };
    return ws;
  };

  it(`is at least Hocuspocus's maxPendingDocuments, so Hocuspocus's own bound is what an honest socket meets first`, () => {
    expect(COLLAB_DOCUMENTS_PER_SOCKET).toBeGreaterThanOrEqual(COLLAB_HOCUSPOCUS_OPTIONS.maxPendingDocuments);
  });

  it(`admits frames for ${COLLAB_DOCUMENTS_PER_SOCKET} names, any number of times each; the next new name terminates`, () => {
    const ws = socket();
    const warn = jest.fn();
    const limitLog = new SocketLimitLog({ warn });
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < COLLAB_DOCUMENTS_PER_SOCKET; i++) expect(admitCollabFrame(ws, typed(pageN(i), 0), limitLog)).toBe(true);
    }
    expect(ws.terminate).not.toHaveBeenCalled();
    expect(admitCollabFrame(ws, typed(pageN(99), 0), limitLog)).toBe(false);
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls).toEqual([[`COLLAB_SOCKET_LIMIT {"limit":"socket_documents","documents":${COLLAB_DOCUMENTS_PER_SOCKET + 1}}`]]);
  });

  it('a flood of fresh names in one TCP read reaches the downstream handler at most the cap times', () => {
    const ws = socket();
    const limitLog = new SocketLimitLog({ warn: () => undefined });
    let forwarded = 0;
    for (let i = 0; i < 1500; i++) if (admitCollabFrame(ws, typed(pageN(i), 0), limitLog)) forwarded++;
    expect(forwarded).toBe(COLLAB_DOCUMENTS_PER_SOCKET);
    expect(ws.terminate).toHaveBeenCalledTimes(1);
  });

  it('the count is per socket', () => {
    const limitLog = new SocketLimitLog({ warn: () => undefined });
    for (let s = 0; s < 3; s++) {
      const ws = socket();
      for (let i = 0; i < COLLAB_DOCUMENTS_PER_SOCKET; i++) expect(admitCollabFrame(ws, typed(pageN(i), 0), limitLog)).toBe(true);
    }
  });
});

describe('#790 admitCollabFrame: Auth frames per socket (a refused Auth can otherwise be retried forever)', () => {
  const socket = () => {
    const ws = { readyState: 1, terminate: jest.fn(() => (ws.readyState = 2)) };
    return ws;
  };

  it(`admits ${COLLAB_AUTH_FRAMES_PER_SOCKET} Auth frames, terminates on the next; other types are not counted`, () => {
    const ws = socket();
    const warn = jest.fn();
    const limitLog = new SocketLimitLog({ warn });
    const page = pageN(1);
    for (let i = 0; i < 50; i++) expect(admitCollabFrame(ws, typed(page, 0), limitLog)).toBe(true); // Sync
    for (let i = 0; i < 50; i++) expect(admitCollabFrame(ws, typed(page, 1), limitLog)).toBe(true); // Awareness
    for (let i = 0; i < COLLAB_AUTH_FRAMES_PER_SOCKET; i++) expect(admitCollabFrame(ws, typed(page, 2), limitLog)).toBe(true);
    expect(ws.terminate).not.toHaveBeenCalled();
    expect(admitCollabFrame(ws, typed(page, 2), limitLog)).toBe(false);
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls).toEqual([[`COLLAB_SOCKET_LIMIT {"limit":"socket_auth_frames","authFrames":${COLLAB_AUTH_FRAMES_PER_SOCKET + 1}}`]]);
  });

  it('an honest open (one Auth per document, then sync and awareness) is far inside the budget', () => {
    expect(COLLAB_AUTH_FRAMES_PER_SOCKET).toBeGreaterThanOrEqual(COLLAB_DOCUMENTS_PER_SOCKET);
  });

  it('counts the type as lib0 reads it: a non-minimal varint 2 (0x82 0x00) is an Auth frame too', () => {
    const ws = socket();
    const limitLog = new SocketLimitLog({ warn: () => undefined });
    const name = pageN(1);
    const e = encoding.createEncoder();
    encoding.writeVarString(e, name);
    const head = encoding.toUint8Array(e);
    const padded = new Uint8Array([...head, 0x82, 0x00, 0, 0]);
    const d = decoding.createDecoder(padded);
    decoding.readVarString(d);
    expect(decoding.readVarUint(d)).toBe(2); // what Hocuspocus reads
    for (let i = 0; i < COLLAB_AUTH_FRAMES_PER_SOCKET; i++) expect(admitCollabFrame(ws, padded, limitLog)).toBe(true);
    expect(admitCollabFrame(ws, padded, limitLog)).toBe(false);
  });
});

describe('#790 admitCollabFrame: the awareness rate (over-rate awareness is dropped, never refused)', () => {
  const AWARENESS = 1;
  const QUERY_AWARENESS = 3;
  const clocked = () => {
    let t = 5_000_000;
    const ws = { readyState: 1, terminate: jest.fn(() => (ws.readyState = 2)) };
    const warn = jest.fn();
    const limitLog = new SocketLimitLog({ warn });
    const admit = (type: number, name = pageN(1)) => admitCollabFrame(ws, typed(name, type), limitLog, () => t);
    return { ws, warn, admit, advance: (ms: number) => (t += ms) };
  };

  it(`admits a burst of ${COLLAB_AWARENESS_BURST} (QueryAwareness counts too), drops the next, and leaves the socket up and unlogged`, () => {
    const { ws, warn, admit } = clocked();
    for (let i = 0; i < COLLAB_AWARENESS_BURST - 1; i++) expect(admit(AWARENESS)).toBe(true);
    expect(admit(QUERY_AWARENESS)).toBe(true);
    for (let i = 0; i < 50; i++) expect(admit(AWARENESS)).toBe(false);
    expect(admit(QUERY_AWARENESS)).toBe(false);
    expect(ws.terminate).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('never drops a Sync frame (that would lose an edit) or an Auth frame, however empty the bucket', () => {
    const { ws, admit } = clocked();
    for (let i = 0; i < COLLAB_AWARENESS_BURST + 10; i++) admit(AWARENESS);
    for (let i = 0; i < 1000; i++) expect(admit(0)).toBe(true); // Sync
    expect(admit(2)).toBe(true); // Auth
    expect(admit(7)).toBe(true); // Close
    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it(`refills at ${COLLAB_AWARENESS_REFILL_PER_SECOND}/s up to the burst, and the bucket is per socket`, () => {
    const { admit, advance } = clocked();
    for (let i = 0; i < COLLAB_AWARENESS_BURST; i++) admit(AWARENESS);
    expect(admit(AWARENESS)).toBe(false);
    advance(1000 / COLLAB_AWARENESS_REFILL_PER_SECOND);
    expect(admit(AWARENESS)).toBe(true);
    expect(admit(AWARENESS)).toBe(false);
    advance(3_600_000);
    let admitted = 0;
    for (let i = 0; i < COLLAB_AWARENESS_BURST * 3; i++) if (admit(AWARENESS)) admitted++;
    expect(admitted).toBe(COLLAB_AWARENESS_BURST);
    expect(clocked().admit(AWARENESS)).toBe(true); // another socket has its own bucket
  });

  it('a flood is held to the refill rate after the burst', () => {
    const { ws, admit, advance } = clocked();
    let admitted = 0;
    for (let ms = 0; ms < 10_000; ms++) {
      for (let k = 0; k < 2; k++) if (admit(AWARENESS)) admitted++;
      advance(1);
    }
    expect(admitted).toBeLessThanOrEqual(COLLAB_AWARENESS_BURST + 10 * COLLAB_AWARENESS_REFILL_PER_SECOND + 1);
    expect(admitted).toBeGreaterThanOrEqual(COLLAB_AWARENESS_BURST + 10 * COLLAB_AWARENESS_REFILL_PER_SECOND - 1);
    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it('honest editing: a held arrow key (33/s) for a minute loses nothing; a 240 Hz drag for 10 s only thins its cursor frames', () => {
    const { ws, admit, advance } = clocked();
    for (let i = 0; i < 33 * 60; i++) {
      expect(admit(AWARENESS)).toBe(true);
      advance(1000 / 33);
    }
    let admitted = 0;
    for (let i = 0; i < 240 * 10; i++) {
      if (admit(AWARENESS)) admitted++;
      advance(1000 / 240);
    }
    expect(admitted).toBeGreaterThan(COLLAB_AWARENESS_BURST); // peers keep seeing the cursor move
    expect(ws.terminate).not.toHaveBeenCalled(); // and the session never ends
    advance(1000);
    expect(admit(AWARENESS)).toBe(true); // the frame after the drag gets through
  });
});

describe('#810 admitCollabFrame: the awareness bucket charges bytes, at least COLLAB_AWARENESS_MIN_CHARGE_BYTES a frame', () => {
  // Mutation arm (recorded in the #810 notes): charging COLLAB_AWARENESS_MIN_CHARGE_BYTES (one frame) whatever the
  // frame's length turns the large-frame tests red, while the small-frame tests above stay green.
  const AWARENESS = 1;
  const KiB = 1024;
  /** An Awareness frame of exactly `total` bytes on `name` (the gate reads only the name and the type). */
  const sized = (total: number, name = pageN(1)): Uint8Array => {
    const frame = new Uint8Array(total);
    frame.set(typed(name, AWARENESS).subarray(0, 1 + 41 + 1));
    return frame;
  };
  const clocked = () => {
    let t = 9_000_000;
    const ws = { readyState: 1, terminate: jest.fn(() => (ws.readyState = 2)) };
    const warn = jest.fn();
    const limitLog = new SocketLimitLog({ warn });
    const admit = (frame: Uint8Array) => admitCollabFrame(ws, frame, limitLog, () => t);
    return { ws, warn, admit, advance: (ms: number) => (t += ms) };
  };

  it('the byte bucket is the frame bucket at the minimum charge: 200 frames (100 KiB), then 40 frames (20 KiB) a second', () => {
    expect(COLLAB_AWARENESS_MIN_CHARGE_BYTES).toBe(512);
    expect(COLLAB_AWARENESS_BURST_BYTES).toBe(COLLAB_AWARENESS_BURST * COLLAB_AWARENESS_MIN_CHARGE_BYTES);
    expect(COLLAB_AWARENESS_BURST_BYTES).toBe(100 * KiB);
    expect(COLLAB_AWARENESS_REFILL_BYTES_PER_SECOND).toBe(COLLAB_AWARENESS_REFILL_PER_SECOND * COLLAB_AWARENESS_MIN_CHARGE_BYTES);
    expect(COLLAB_AWARENESS_REFILL_BYTES_PER_SECOND).toBe(20 * KiB);
  });

  it('a 512 KiB frame (64 ids × 8 KiB states) is never admitted, from a full bucket or after an hour; the socket stays, nothing logged', () => {
    const { ws, warn, admit, advance } = clocked();
    let admitted = 0;
    for (let i = 0; i < 50; i++) {
      if (admit(sized(512 * KiB))) admitted++;
      advance(3_600_000);
    }
    expect(admitted).toBe(0); // larger than the whole bucket: at most once per burst is never
    expect(ws.terminate).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(admit(sized(300))).toBe(true); // the socket's honest awareness still flows
  });

  it('a burst-sized frame is admitted once per burst: dropped until the whole burst refilled (5 s), and it empties the bucket for small frames too', () => {
    const { ws, warn, admit, advance } = clocked();
    const refillMs = (1000 * COLLAB_AWARENESS_BURST_BYTES) / COLLAB_AWARENESS_REFILL_BYTES_PER_SECOND;
    expect(refillMs).toBe(5_000);
    expect(admit(sized(COLLAB_AWARENESS_BURST_BYTES))).toBe(true);
    expect(admit(sized(COLLAB_AWARENESS_BURST_BYTES))).toBe(false);
    expect(admit(sized(100))).toBe(false); // one bucket: the bytes are spent
    advance(refillMs - 1);
    expect(admit(sized(COLLAB_AWARENESS_BURST_BYTES))).toBe(false);
    advance(1);
    expect(admit(sized(COLLAB_AWARENESS_BURST_BYTES))).toBe(true);
    expect(ws.terminate).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('a sustained flood of 7 KiB frames is held to the burst plus the byte refill (the bytes every peer is owed)', () => {
    const { ws, admit, advance } = clocked();
    const FRAME = 7 * KiB;
    let bytes = 0;
    for (let ms = 0; ms < 10_000; ms += 5) {
      if (admit(sized(FRAME))) bytes += FRAME;
      advance(5);
    }
    expect(bytes).toBeLessThanOrEqual(COLLAB_AWARENESS_BURST_BYTES + 10 * COLLAB_AWARENESS_REFILL_BYTES_PER_SECOND);
    expect(bytes).toBeGreaterThan(COLLAB_AWARENESS_BURST_BYTES + 10 * COLLAB_AWARENESS_REFILL_BYTES_PER_SECOND - 2 * FRAME);
    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it('an honest 300 B state at 40/s for 60 s is never dropped; frames up to the minimum charge all cost the same', () => {
    const { ws, admit, advance } = clocked();
    for (let i = 0; i < 40 * 60; i++) {
      expect(admit(sized(300))).toBe(true);
      advance(1000 / 40);
    }
    expect(ws.terminate).not.toHaveBeenCalled();
    const b = clocked();
    let admitted = 0;
    for (let i = 0; i < COLLAB_AWARENESS_BURST * 2; i++) if (b.admit(sized(COLLAB_AWARENESS_MIN_CHARGE_BYTES))) admitted++;
    expect(admitted).toBe(COLLAB_AWARENESS_BURST);
  });
});

describe('#810 (A5): the wire constants come from Hocuspocus 4.7.1, and are the values the wire uses', () => {
  it('MessageType, AuthMessageType and WsReadyStates match the literal wire values (testkit MSG is the independent oracle)', () => {
    expect({
      Sync: MessageType.Sync,
      Awareness: MessageType.Awareness,
      Auth: MessageType.Auth,
      QueryAwareness: MessageType.QueryAwareness,
      SyncReply: MessageType.SyncReply,
      Stateless: MessageType.Stateless,
      BroadcastStateless: MessageType.BroadcastStateless,
      Close: MessageType.CLOSE,
      SyncStatus: MessageType.SyncStatus,
    }).toEqual(MSG);
    expect([MessageType.Ping, MessageType.Pong]).toEqual([9, 10]);
    expect([AuthMessageType.Token, AuthMessageType.PermissionDenied, AuthMessageType.Authenticated]).toEqual([0, 1, 2]);
    expect(WsReadyStates.Open).toBe(1);
  });

  it('trap, documented: a bare 4.7.1 provider Pong ([10], no document name) is refused frame_address', () => {
    // The 4.7.1 server sends no app-level Ping (the keepalive uses ws protocol pings), so no honest provider sends this.
    // If a future Hocuspocus server starts app-level pings, its providers' Pongs would terminate every socket here.
    const ws = { readyState: 1, terminate: jest.fn() };
    expect(admitCollabFrame(ws, new Uint8Array([MessageType.Pong]), new SocketLimitLog({ warn: () => undefined }))).toBe(false);
    expect(ws.terminate).toHaveBeenCalledTimes(1);
  });
});

describe('#810 (N1) admitCollabFrame: the first complete Auth frame tells the pre-auth slots', () => {
  const quiet = () => new SocketLimitLog({ warn: () => undefined });
  const socket = () => {
    const ws = { readyState: 1, terminate: jest.fn(() => (ws.readyState = 2)) };
    return ws;
  };

  it('only the first Auth frame, once; Sync, Awareness and QueryAwareness never do', () => {
    const ws = socket();
    const preAuth = { authArrived: jest.fn() };
    const page = pageN(1);
    for (const type of [MessageType.Sync, MessageType.Awareness, MessageType.QueryAwareness]) {
      expect(admitCollabFrame(ws, typed(page, type), quiet(), Date.now, preAuth)).toBe(true);
    }
    expect(preAuth.authArrived).not.toHaveBeenCalled();
    expect(admitCollabFrame(ws, typed(page, MessageType.Auth), quiet(), Date.now, preAuth)).toBe(true);
    expect(preAuth.authArrived.mock.calls).toEqual([[ws]]);
    for (let i = 1; i < COLLAB_AUTH_FRAMES_PER_SOCKET; i++) admitCollabFrame(ws, typed(page, MessageType.Auth), quiet(), Date.now, preAuth);
    expect(preAuth.authArrived).toHaveBeenCalledTimes(1);
  });

  it('a refused frame never reports: a junk-named Auth, and an Auth on a socket no longer open', () => {
    const preAuth = { authArrived: jest.fn() };
    const junk = socket();
    expect(admitCollabFrame(junk, typed('collabLock:x', MessageType.Auth), quiet(), Date.now, preAuth)).toBe(false);
    const closing = { readyState: 2, terminate: jest.fn() };
    expect(admitCollabFrame(closing, typed(pageN(1), MessageType.Auth), quiet(), Date.now, preAuth)).toBe(false);
    expect(preAuth.authArrived).not.toHaveBeenCalled();
  });
});
