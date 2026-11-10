import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { admitCollabFrame, isCollabFrameAddress } from './frame-address';
import { SocketLimitLog } from './socket-limit-log';

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
    ['uuid v4, lower case', `page.${V4}`],
    ['uuid v4, upper case', `page.${V4.toUpperCase()}`],
    ['uuid v7', `page.${V7}`],
    ['uuid v7, upper case', `page.${V7.toUpperCase()}`],
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

describe('#790 SocketLimitLog', () => {
  afterEach(() => jest.restoreAllMocks());

  it('logs at most 30 lines a minute, then one line with the suppressed count', () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const warn = jest.fn();
    const limitLog = new SocketLimitLog({ warn });
    for (let i = 0; i < 45; i++) limitLog.log('auth_rate', { userId: 'u1' });
    expect(warn).toHaveBeenCalledTimes(30);
    now += 60_000;
    limitLog.log('auth_rate', { userId: 'u1' });
    expect(warn.mock.calls.slice(30).map((c) => c[0])).toEqual([
      'COLLAB_SOCKET_LIMIT {"limit":"log_suppressed","count":15}',
      'COLLAB_SOCKET_LIMIT {"limit":"auth_rate","userId":"u1"}',
    ]);
  });
});
