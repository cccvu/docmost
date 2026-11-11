import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COLLAB_CONNECTIONS_PER_USER,
  COLLAB_INBOUND_CHUNK_OVERHEAD_BYTES,
  COLLAB_MAX_PAYLOAD_BYTES,
  COLLAB_OUTBOUND_BUFFER_FACTOR,
  COLLAB_OUTBOUND_FRAME_OVERHEAD_BYTES,
  COLLAB_PREAUTH_SOCKET_BYTES,
  COLLAB_SOCKET_TOTAL_BYTES,
  COLLAB_SOCKET_TOTAL_LOW_WATER_BYTES,
  COLLAB_WS_SERVER_OPTIONS,
} from './limits';

/**
 * #810 sizing: the per-frame and per-read heap overheads the byte accounting charges (limits.ts), against what ws
 * 8.21.0 really costs. Measured by socket-bytes.sizing.bench.cjs on a REAL loopback TCP socket whose client never
 * reads, on the production base image, with the fork's own ws mounted read-only:
 *
 *   docker run --rm --network none -v <docmost>/node_modules/.pnpm/ws@8.21.0/node_modules/ws:/ws:ro \
 *     -v <this dir>/socket-bytes.sizing.bench.cjs:/b.cjs:ro node:22-slim node --expose-gc /b.cjs /ws
 *
 * 2026-11-11, node:22-slim = Node 22.23.4 (production), and Node 24.21.0 for comparison:
 *
 *   per queued frame, 50 B payload      heap    ArrayBuffer   bufferedAmount
 *     distinct payload       node 22    397.2   58.0          52      overhead past bufferedAmount: 397 + 8 = 405
 *                            node 24    421.1   57.9          52                                    421 + 8 = 429
 *     shared (a broadcast)   node 22    309.7    7.9          52      310 + 8 = 318 (the payload is held once)
 *                            node 24    325.5    7.9          52
 *   (2048 B payloads: the same heap per frame, to 0.5 B)
 *   per ping, ws autoPong on node 22    205.3    8.3          2       a queued pong, outside every bound
 *                            node 24    222.0    9.5          2
 *   per ping, autoPong off   node 22      0.0    0.3          0
 *   per 128 B TCP read held in a frame ws is assembling:
 *                            node 22    231.5   128 (the read)        (a first run: 230.2)
 *                            node 24    245.5   128                   (a first run: 238.1)
 *
 * So COLLAB_OUTBOUND_FRAME_OVERHEAD_BYTES = 512 covers a distinct frame's 405 B on production with 26% to spare (19%
 * on Node 24), and COLLAB_INBOUND_CHUNK_OVERHEAD_BYTES = 256 a read's 232 B with 10% (4% on Node 24: re-measure on a
 * Node major bump). A Node upgrade re-runs the bench and updates this table, and the assertions below.
 */
const MEASURED_NODE22 = { frameDistinct: 397.2 + 8.0, frameShared: 309.7 + 7.9, pong: 205.3 + 8.3, read: 231.5 };
const MEASURED_NODE24 = { frameDistinct: 421.1 + 7.9, frameShared: 325.5 + 7.9, pong: 222.0 + 9.5, read: 245.5 };
const MiB = 1024 * 1024;

describe('#810 sizing: the byte accounting overheads cover the measured heap', () => {
  it('the per-frame overhead covers a queued frame on node 22 (production) and node 24', () => {
    for (const m of [MEASURED_NODE22, MEASURED_NODE24]) {
      expect(COLLAB_OUTBOUND_FRAME_OVERHEAD_BYTES).toBeGreaterThanOrEqual(Math.max(m.frameDistinct, m.frameShared));
    }
    expect(COLLAB_OUTBOUND_FRAME_OVERHEAD_BYTES).toBeGreaterThanOrEqual(1.2 * MEASURED_NODE22.frameDistinct); // production margin
  });

  it('the per-read overhead covers a held TCP read on node 22 (production) and node 24', () => {
    for (const m of [MEASURED_NODE22, MEASURED_NODE24]) expect(COLLAB_INBOUND_CHUNK_OVERHEAD_BYTES).toBeGreaterThanOrEqual(m.read);
    expect(COLLAB_INBOUND_CHUNK_OVERHEAD_BYTES).toBeGreaterThanOrEqual(1.1 * MEASURED_NODE22.read);
  });

  it('one socket fed tiny frames holds a few MB of heap, not 62 MB', () => {
    const allowance = COLLAB_OUTBOUND_BUFFER_FACTOR * COLLAB_MAX_PAYLOAD_BYTES + 52; // its largest frame: 52 B
    const before = Math.floor(allowance / 52); // #790: only the bytes counted
    const now = Math.floor(allowance / (52 + COLLAB_OUTBOUND_FRAME_OVERHEAD_BYTES));
    expect(before * MEASURED_NODE22.frameDistinct).toBeGreaterThan(60 * 1e6);
    expect(now * MEASURED_NODE22.frameDistinct).toBeLessThan(6.5 * 1e6);
    // and one account's 32 such sockets stay well under docmost's 1 GiB heap (they were past it)
    expect(COLLAB_CONNECTIONS_PER_USER * before * MEASURED_NODE22.frameDistinct).toBeGreaterThan(1024 * MiB);
    expect(COLLAB_CONNECTIONS_PER_USER * now * MEASURED_NODE22.frameDistinct).toBeLessThan(256 * MiB);
  });

  it('with autoPong on, one socket’s pre-auth allowance of pings would be hundreds of MB; it is off', () => {
    // one unauthenticated socket's 9 MiB of 6-byte pings, each queueing a pong behind a socket that never reads
    expect((COLLAB_PREAUTH_SOCKET_BYTES / 6) * MEASURED_NODE22.pong).toBeGreaterThan(300 * 1e6);
    expect(COLLAB_WS_SERVER_OPTIONS.autoPong).toBe(false);
  });

  it('the budget: 128 MiB, cut down to 112 MiB (each pass buys 16 MiB)', () => {
    expect(COLLAB_SOCKET_TOTAL_BYTES).toBe(128 * MiB);
    expect(COLLAB_SOCKET_TOTAL_LOW_WATER_BYTES).toBe((COLLAB_SOCKET_TOTAL_BYTES / 8) * 7);
    expect(COLLAB_SOCKET_TOTAL_BYTES - COLLAB_SOCKET_TOTAL_LOW_WATER_BYTES).toBe(16 * MiB);
  });

  it('the bench is the one the table names (anti-vacuity: the script is there and measures on a real socket)', () => {
    const bench = readFileSync(join(__dirname, 'socket-bytes.sizing.bench.cjs'), 'utf8');
    expect(bench).toMatch(/net\.connect\(/);
    expect(bench).toMatch(/perMessageDeflate: false/);
    for (const kind of ['outbound_shared', 'outbound_distinct', 'pong_auto', 'pong_off', 'inbound_read']) expect(bench).toContain(kind);
  });
});
