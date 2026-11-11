// CCC collab integration — NOT upstream Docmost code (#810, ADR 0036). Not a test: the measurement behind
// COLLAB_OUTBOUND_FRAME_OVERHEAD_BYTES and COLLAB_INBOUND_CHUNK_OVERHEAD_BYTES (socket-bytes.sizing.spec.ts says how
// to run it). Heap per frame ws queues for a client that never reads, per pong ws's autoPong queues, and per TCP read
// ws holds while it assembles a frame, all on a REAL loopback TCP socket.
// Usage: node --expose-gc socket-bytes.sizing.bench.cjs <ws package dir>
const WS = require(process.argv[2]);
const net = require('net');
const N = 100000;
const mem = () => {
  gc();
  gc();
  return process.memoryUsage();
};
const per = (a, b, key, n) => +((b[key] - a[key]) / n).toFixed(1);
const serverWith = (opts) => new Promise((resolve) => {
  const wss = new WS.WebSocketServer({ port: 0, perMessageDeflate: false, ...opts }, () => resolve(wss));
});
// a raw TCP client: upgrades, then never reads again
const pausedClient = (port) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1', () => {
    s.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
  });
  s.once('data', () => {
    s.pause();
    resolve(s);
  });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function open(opts) {
  const wss = await serverWith(opts);
  const conn = new Promise((r) => wss.once('connection', r));
  const client = await pausedClient(wss.address().port);
  const ws = await conn;
  return { wss, client, ws, done: () => (client.destroy(), ws.terminate(), wss.close()) };
}
async function backUp(ws) {
  // fill the kernel's buffers so every later write waits in ws's (Node's) send buffer
  for (let i = 0; i < 64 && ws.bufferedAmount < 4 * 1024 * 1024; i++) {
    ws.send(Buffer.alloc(1024 * 1024));
    await sleep(5);
  }
}
async function outbound(shared, size) {
  const s = await open({});
  await backUp(s.ws);
  const one = new Uint8Array(size);
  const cb = () => {};
  const m0 = mem();
  const b0 = s.ws.bufferedAmount;
  for (let i = 0; i < N; i++) s.ws.send(shared ? one : new Uint8Array(size), cb);
  const m1 = mem();
  const out = { kind: shared ? 'outbound_shared' : 'outbound_distinct', size, bufferedPerFrame: +((s.ws.bufferedAmount - b0) / N).toFixed(1), heapPerFrame: per(m0, m1, 'heapUsed', N), arrayBuffersPerFrame: per(m0, m1, 'arrayBuffers', N) };
  s.done();
  return out;
}
async function pongs(autoPong) {
  const s = await open({ autoPong });
  await backUp(s.ws);
  let pings = 0;
  s.ws.on('ping', () => pings++);
  const ping = Buffer.from([0x89, 0x80, 0, 0, 0, 0]); // an empty masked ping: 6 bytes on the wire
  const batch = Buffer.concat(Array(1000).fill(ping));
  const m0 = mem();
  const b0 = s.ws.bufferedAmount;
  for (let i = 0; i < N / 1000; i++) s.client.write(batch);
  while (pings < N) await sleep(10);
  const m1 = mem();
  const out = { kind: autoPong ? 'pong_auto' : 'pong_off', bufferedPerPing: +((s.ws.bufferedAmount - b0) / N).toFixed(2), heapPerPing: per(m0, m1, 'heapUsed', N), arrayBuffersPerPing: per(m0, m1, 'arrayBuffers', N) };
  s.done();
  return out;
}
async function inbound(size, chunks) {
  // a frame ws is still assembling, delivered in `size`-byte TCP reads (each write waits for the server to read it)
  const s = await open({ maxPayload: 64 * 1024 * 1024, maxBufferedChunks: chunks + 10 });
  let reads = 0;
  s.ws._socket.on('data', () => reads++);
  const head = Buffer.alloc(14);
  head[0] = 0x82;
  head[1] = 0x80 | 127;
  head.writeBigUInt64BE(BigInt(chunks * size * 4), 2);
  s.client.setNoDelay(true);
  s.client.write(head);
  await sleep(20);
  const m0 = mem();
  const r0 = reads;
  for (let i = 0; i < chunks; i++) {
    s.client.write(Buffer.alloc(size));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  }
  await sleep(200);
  const m1 = mem();
  const n = reads - r0;
  const out = { kind: 'inbound_read', size, reads: n, heapPerRead: per(m0, m1, 'heapUsed', n), arrayBuffersPerRead: per(m0, m1, 'arrayBuffers', n) };
  s.done();
  return out;
}
(async () => {
  console.log(JSON.stringify({ node: process.version, ws: require(process.argv[2] + '/package.json').version }));
  for (const run of [() => outbound(true, 50), () => outbound(false, 50), () => outbound(true, 2048), () => outbound(false, 2048), () => pongs(true), () => pongs(false), () => inbound(128, 4000)]) {
    console.log(JSON.stringify(await run()));
  }
  process.exit(0);
})();
