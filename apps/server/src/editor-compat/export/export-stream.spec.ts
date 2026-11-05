import * as JSZip from 'jszip';
import { finished, PassThrough, Readable, Writable } from 'node:stream';
import { ExportStorageException, ExportTimeoutException, ExportTooLargeException } from './export-limits';
import { ExportStreamRegistry } from './export-stream';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

// A full GC on demand, so the memory spec measures what the export RETAINS, not garbage V8 has not collected yet.
setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
/** arrayBuffers after a full GC, given the background ArrayBuffer sweeper time to actually free the backing stores. */
async function settled(): Promise<number> {
  for (let i = 0; i < 2; i++) {
    gc();
    await new Promise((r) => setTimeout(r, 20));
  }
  return process.memoryUsage().arrayBuffers;
}

/**
 * #699 — the lazy attachment stream + per-export registry, driven through the REAL JSZip 3.10.1
 * `generateNodeStream({ streamFiles: true })` the export uses. Fork-owned.
 */

const MiB = 1024 * 1024;
const LIMITS = { attachmentBytes: 2 * 1024 * MiB, maxDurationMs: 60_000 };

/** A storage object of `size` bytes, emitted as fresh 64 KiB Buffers (as an S3 body or a file stream would). */
function synthetic(size: number, fill = 0x61): Readable {
  let sent = 0;
  return new Readable({
    read() {
      if (sent >= size) {
        this.push(null);
        return;
      }
      const n = Math.min(64 * 1024, size - sent);
      sent += n;
      this.push(Buffer.alloc(n, fill));
    },
  });
}

/** An `open()` spy that tracks how many storage objects are open at once. */
function storage(make: (i: number) => Readable) {
  const state = { opens: 0, live: 0, maxLive: 0, sources: [] as Readable[] };
  const open = (i: number) => async () => {
    state.opens++;
    state.live++;
    state.maxLive = Math.max(state.maxLive, state.live);
    const s = make(i);
    state.sources.push(s);
    let done = false;
    const close = () => {
      if (!done) {
        done = true;
        state.live--;
      }
    };
    s.once('end', close);
    finished(s, close);
    return s;
  };
  return { state, open };
}

const logger = () => ({ warn: jest.fn(), error: jest.fn() });

function generate(zip: JSZip) {
  return zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE' });
}

/** Read a stream to the end (or its error) into one Buffer. */
function collect(s: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    s.on('data', (c: Buffer) => parts.push(c));
    s.once('end', () => resolve(Buffer.concat(parts)));
    s.once('error', reject);
  });
}

/** Resolves with the stream's error once it is destroyed; rejects if it ends cleanly instead (a silent short archive). */
function destroyedWith(s: Readable, ms = 2000): Promise<Error | undefined> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`not destroyed within ${ms} ms`)), ms);
    let err: Error | undefined;
    s.on('error', (e) => (err = e));
    s.once('end', () => {
      clearTimeout(t);
      reject(new Error('the stream ENDED cleanly: a truncated archive would have been sent as complete'));
    });
    s.once('close', () => {
      clearTimeout(t);
      resolve(err);
    });
  });
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe('LazyAttachmentStream + ExportStreamRegistry over real JSZip (#699)', () => {
  it('opens nothing when entries are added, and at most ONE storage object at a time while generating', async () => {
    const { state, open } = storage(() => synthetic(3 * MiB));
    const reg = new ExportStreamRegistry('page:p1', LIMITS, logger());
    const zip = new JSZip();
    zip.file('page.md', '# page');
    for (let i = 0; i < 8; i++) {
      zip.file(`/files/a${i}/f${i}.bin`, reg.lazy(`a${i}`, open(i)), { binary: true, compression: 'STORE' });
    }
    await tick();
    expect(state.opens).toBe(0); // JSZip binds + pauses the stream at file(); nothing is read until generation

    const out = reg.attach(generate(zip));
    await tick();
    expect(state.opens).toBeLessThanOrEqual(1); // nothing is opened ahead of the reader
    const buf = await collect(out);
    expect(state.opens).toBe(8);
    expect(state.maxLive).toBe(1); // one socket per export, never one per attachment

    const back = await JSZip.loadAsync(buf);
    for (let i = 0; i < 8; i++) {
      const f = back.file(`/files/a${i}/f${i}.bin`);
      expect(f).not.toBeNull();
      const bytes = await f!.async('nodebuffer');
      expect(bytes.length).toBe(3 * MiB);
      expect(bytes.every((b) => b === 0x61)).toBe(true);
    }
    expect(await back.file('page.md')!.async('string')).toBe('# page');
  });

  it('a client abort (fastify destroys the payload) destroys the open source and opens nothing more', async () => {
    const { state, open } = storage(() => synthetic(32 * MiB));
    const reg = new ExportStreamRegistry('page:p1', LIMITS, logger());
    const zip = new JSZip();
    for (let i = 0; i < 4; i++) zip.file(`/files/a${i}/f.bin`, reg.lazy(`a${i}`, open(i)), { binary: true, compression: 'STORE' });
    const out = reg.attach(generate(zip));
    let seen = 0;
    await new Promise<void>((resolve) => {
      out.on('data', (c: Buffer) => {
        seen += c.length;
        if (seen > 2 * MiB) {
          out.removeAllListeners('data');
          out.pause();
          resolve();
        }
      });
    });
    expect(state.opens).toBe(1);
    const src = state.sources[0];
    expect(src.destroyed).toBe(false);
    out.destroy(); // what fastify's sendStream does when the response closes early (reply.js:797-798)
    await tick(50);
    expect(src.destroyed).toBe(true);
    expect(state.live).toBe(0);
    expect(state.opens).toBe(1);
  });

  it('a source error while JSZip has the input PAUSED (backpressure) still destroys the response, within a bound', async () => {
    // JSZip 3.10.1 swallows this error (NodejsStreamInputAdapter.js:38-43 stores it on the stream), so the archive
    // would simply stop: the registry must not depend on JSZip to surface it.
    const { state, open } = storage(() => synthetic(64 * MiB));
    const log = logger();
    const reg = new ExportStreamRegistry('space:s1', LIMITS, log);
    const zip = new JSZip();
    zip.file('/files/a0/big.bin', reg.lazy('a0', open(0)), { binary: true, compression: 'STORE' });
    zip.file('/files/a1/next.bin', reg.lazy('a1', open(1)), { binary: true, compression: 'STORE' });
    const out = reg.attach(generate(zip));
    let seen = 0;
    await new Promise<void>((resolve) => {
      const onData = (c: Buffer) => {
        seen += c.length;
        if (seen < 256 * 1024) return;
        out.pause(); // the client stops reading: backpressure pauses JSZip, then the source
        out.removeListener('data', onData);
        resolve();
      };
      out.on('data', onData);
    });
    await tick(100);
    expect(state.opens).toBe(1);
    expect(state.sources[0].isPaused()).toBe(true);
    expect(state.sources[0].readableEnded).toBe(false);

    const destroyed = destroyedWith(out);
    state.sources[0].destroy(new Error('read ECONNRESET')); // S3 resets the idle socket
    const err = await destroyed;
    expect(err).toBeInstanceOf(ExportStorageException);
    expect(state.opens).toBe(1); // the next entry is never opened
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/^EXPORT_ABORTED reason=storage_error export=space:s1 attachment=a0 .*ECONNRESET/));
  });

  it('a storage object that cannot be opened (e.g. vanished after the check) fails the archive; it never ends cleanly', async () => {
    const reg = new ExportStreamRegistry('page:p1', LIMITS, logger());
    const zip = new JSZip();
    zip.file('page.md', 'x');
    zip.file('/files/a0/f.bin', reg.lazy('a0', async () => {
      throw Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' });
    }), { binary: true, compression: 'STORE' });
    const out = reg.attach(generate(zip));
    out.on('data', () => undefined);
    expect(await destroyedWith(out)).toBeInstanceOf(ExportStorageException);
  });

  it('a HUNG open fails the archive after EXPORT_STORAGE_TIMEOUT_MS, and a stream that arrives later is released', async () => {
    const log = logger();
    const reg = new ExportStreamRegistry('page:p1', { ...LIMITS, storageTimeoutMs: 100 }, log);
    const zip = new JSZip();
    let arrive!: (s: Readable) => void;
    zip.file('/files/a0/f.bin', reg.lazy('a0', () => new Promise<Readable>((r) => (arrive = r))), { binary: true, compression: 'STORE' });
    const out = reg.attach(generate(zip));
    out.on('data', () => undefined);
    const t0 = Date.now();
    expect(await destroyedWith(out, 3000)).toBeInstanceOf(ExportStorageException);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/reason=storage_error .*attachment=a0 .*did not answer within 100 ms/));
    const late = synthetic(MiB);
    arrive(late); // the GetObject answers after all: its socket must not stay held
    await tick(20);
    expect(late.destroyed).toBe(true);
  });

  it('a source that closes before its end (premature close, no error) fails the archive', async () => {
    const reg = new ExportStreamRegistry('page:p1', LIMITS, logger());
    const zip = new JSZip();
    zip.file('/files/a0/f.bin', reg.lazy('a0', async () => {
      const s = synthetic(8 * MiB);
      setTimeout(() => s.destroy(), 20);
      return s;
    }), { binary: true, compression: 'STORE' });
    const out = reg.attach(generate(zip));
    const destroyed = destroyedWith(out);
    // read slowly so the source is still open at 20 ms
    out.on('data', () => out.pause());
    const resume = setInterval(() => out.resume(), 5);
    try {
      expect(await destroyed).toBeInstanceOf(ExportStorageException);
    } finally {
      clearInterval(resume);
    }
  });

  it('the streamed-bytes backstop (NULL file_size rows) stops the archive past the budget', async () => {
    const log = logger();
    const reg = new ExportStreamRegistry('page:p1', { attachmentBytes: 5 * MiB, maxDurationMs: 60_000 }, log);
    const zip = new JSZip();
    zip.file('/files/a0/f.bin', reg.lazy('a0', async () => synthetic(4 * MiB)), { binary: true, compression: 'STORE' });
    zip.file('/files/a1/g.bin', reg.lazy('a1', async () => synthetic(4 * MiB)), { binary: true, compression: 'STORE' });
    const out = reg.attach(generate(zip));
    out.on('data', () => undefined);
    expect(await destroyedWith(out)).toBeInstanceOf(ExportTooLargeException);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/^EXPORT_ABORTED reason=byte_cap export=page:p1 /));
  });

  it('the wall-clock cap aborts a stalled export (EXPORT_ABORTED reason=wall_cap) and releases the source', async () => {
    const log = logger();
    const reg = new ExportStreamRegistry('space:s1', { attachmentBytes: LIMITS.attachmentBytes, maxDurationMs: 150 }, log);
    const zip = new JSZip();
    let src: Readable | undefined;
    zip.file('/files/a0/f.bin', reg.lazy('a0', async () => (src = synthetic(64 * MiB))), { binary: true, compression: 'STORE' });
    const out = reg.attach(generate(zip));
    out.once('data', () => out.pause()); // a client that stops reading
    expect(await destroyedWith(out, 3000)).toBeInstanceOf(ExportTimeoutException);
    expect(src?.destroyed).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/^EXPORT_ABORTED reason=wall_cap export=space:s1 /));
  });

  it('the wall-clock cap counts from the start of the export, and a failure before attach throws instead of streaming', async () => {
    let now = 0;
    const reg = new ExportStreamRegistry('page:p1', { attachmentBytes: LIMITS.attachmentBytes, maxDurationMs: 1000 }, logger(), () => now);
    now = 5000; // the pages took longer than the whole budget
    const zip = new JSZip();
    zip.file('a.md', 'a');
    const out = reg.attach(generate(zip));
    expect(await destroyedWith(out)).toBeInstanceOf(ExportTimeoutException);

    const reg2 = new ExportStreamRegistry('page:p2', LIMITS, logger());
    reg2.fail('storage_error', new ExportStorageException());
    const zip2 = new JSZip();
    zip2.file('a.md', 'a');
    expect(() => reg2.attach(generate(zip2))).toThrow(ExportStorageException);
  });

  it('a completed archive clears the wall-clock timer and leaves nothing open', async () => {
    const { state, open } = storage(() => synthetic(MiB));
    const reg = new ExportStreamRegistry('page:p1', LIMITS, logger());
    const zip = new JSZip();
    zip.file('/files/a0/f.bin', reg.lazy('a0', open(0)), { binary: true, compression: 'STORE' });
    const out = reg.attach(generate(zip));
    await collect(out);
    await tick();
    expect((reg as unknown as { timer: unknown }).timer).toBeNull();
    expect(state.live).toBe(0);
    expect(reg.failed).toBeNull();
  });

  it('memory: 20 × 32 MiB of attachments stream with off-heap growth far below their total', async () => {
    const N = 20;
    const SIZE = 32 * MiB;
    const { state, open } = storage(() => synthetic(SIZE));
    const reg = new ExportStreamRegistry('space:s1', LIMITS, logger());
    const zip = new JSZip();
    zip.file('page.md', '# p');
    for (let i = 0; i < N; i++) zip.file(`/files/a${i}/f.bin`, reg.lazy(`a${i}`, open(i)), { binary: true, compression: 'STORE' });

    const base = await settled();
    let peak = base; // raw, garbage included
    let retained = 0; // after a full GC: what the export actually holds
    let bytes = 0;
    let chunks = 0;
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        chunks++;
        if (chunks % 16 === 0) peak = Math.max(peak, process.memoryUsage().arrayBuffers);
        if (chunks % 512 !== 0) return cb();
        settled().then((now) => {
          retained = Math.max(retained, now - base);
          cb();
        }, cb);
      },
    });
    const out = reg.attach(generate(zip));
    await new Promise<void>((resolve, reject) => {
      out.pipe(sink);
      sink.once('finish', resolve);
      out.once('error', reject);
    });
    console.log(
      `#699 memory: streamed ${(bytes / MiB).toFixed(0)} MiB; arrayBuffers peak growth ${((peak - base) / MiB).toFixed(1)} MiB ` +
        `(uncollected garbage included), retained after GC ≤ ${(retained / MiB).toFixed(1)} MiB`,
    );
    expect(bytes).toBeGreaterThan(N * SIZE);
    expect(state.maxLive).toBe(1);
    // What the export holds is what is in flight, whatever the total (measured: ≤ ~4 MiB retained after a GC, ~32 MiB
    // raw peak including garbage). Buffered (the upstream read()), every attachment
    // stays referenced by the JSZip object until the end, so this would reach the total (the control below).
    expect(retained).toBeLessThan((N * SIZE) / 10);
    expect(peak - base).toBeLessThan((N * SIZE) / 2);
  }, 60_000);

  it('memory control (anti-vacuity): the same measurement DOES see buffered attachments retained', async () => {
    const N = 8;
    const SIZE = 8 * MiB;
    const zip = new JSZip();
    const base = await settled();
    for (let i = 0; i < N; i++) zip.file(`/files/a${i}/f.bin`, await collect(synthetic(SIZE)), { binary: true, compression: 'STORE' });
    let retained = 0;
    let chunks = 0;
    const sink = new Writable({
      write(_c: Buffer, _e, cb) {
        if (++chunks % 128 !== 0) return cb();
        settled().then((now) => {
          retained = Math.max(retained, now - base);
          cb();
        }, cb);
      },
    });
    const out = generate(zip);
    await new Promise<void>((resolve) => {
      out.pipe(sink);
      sink.once('finish', resolve);
    });
    expect(retained).toBeGreaterThan(N * SIZE * 0.9);
  }, 60_000);

  it('the response stream is ours, so a failure is never a clean end even after JSZip has been destroyed', async () => {
    const reg = new ExportStreamRegistry('page:p1', LIMITS, logger());
    const zip = new JSZip();
    zip.file('/files/a0/f.bin', reg.lazy('a0', async () => synthetic(8 * MiB)), { binary: true, compression: 'STORE' });
    const out = reg.attach(generate(zip));
    expect(out).toBeInstanceOf(PassThrough);
    out.once('data', () => reg.fail('zip_error', new Error('boom')));
    out.on('data', () => undefined);
    await expect(destroyedWith(out)).resolves.toBeInstanceOf(Error);
  });
});
