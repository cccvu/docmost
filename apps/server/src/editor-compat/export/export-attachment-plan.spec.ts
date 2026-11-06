import * as JSZip from 'jszip';
import { Readable } from 'node:stream';
import { ExportAttachmentPlan, isMissingObjectError, MISSING_ATTACHMENTS_FILE, zipEntryNames } from './export-attachment-plan';
import {
  EXPORT_LIMIT_DEFAULTS,
  ExportLimits,
  ExportStorageException,
  ExportTooLargeException,
  StorageTimeoutError,
  withStorageTimeout,
} from './export-limits';

/** #699 — what an export decides about its attachments before the first byte. Fork-owned. */

const MiB = 1024 * 1024;
const limits = (over: Partial<ExportLimits> = {}): ExportLimits => ({ ...EXPORT_LIMIT_DEFAULTS, ...over });
const logger = () => ({ warn: jest.fn(), error: jest.fn() });
const page = { id: 'page-1', title: 'Page One' };

function fakeStorage(objects: Record<string, Buffer | Error>, existsError?: (path: string) => Error | null) {
  const exists = jest.fn(async (p: string) => {
    const e = existsError?.(p);
    if (e) throw e;
    return p in objects;
  });
  const readStream = jest.fn(async (p: string) => {
    const o = objects[p];
    if (!o || o instanceof Error) throw o ?? new Error(`no ${p}`);
    return Readable.from([o]);
  });
  return { exists, readStream };
}

const att = (id: string, fileSize: number | string | null = 10, fileName = `${id}.png`) => ({
  id,
  fileName,
  filePath: `ws/${id}/${fileName}`,
  fileSize,
});

async function build(plan: ExportAttachmentPlan, zip: JSZip): Promise<JSZip> {
  const out = plan.stream(zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE' }));
  const parts: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    out.on('data', (c: Buffer) => parts.push(c));
    out.once('end', resolve);
    out.once('error', reject);
  });
  return JSZip.loadAsync(Buffer.concat(parts));
}

describe('zipEntryNames — the names JSZip creates for a path (parity with JSZip itself)', () => {
  it.each([
    ['', '/files/a1/x.png'],
    ['Parent/', '/files/a1/x.png'],
    ['A/B/', '/files/a1/x.png'],
    ['', 'plain.md'],
  ])('root %j + %j', (root, rel) => {
    const zip = new JSZip();
    const folder = root ? zip.folder(root.slice(0, -1))! : zip;
    const before = new Set(Object.keys(zip.files));
    folder.file(rel, 'x');
    const created = Object.keys(zip.files).filter((n) => !before.has(n)).sort();
    const predicted = zipEntryNames(`${root}${rel}`).filter((n) => !before.has(n)).sort();
    expect(predicted).toEqual(created);
  });
});

describe('isMissingObjectError', () => {
  it('recognizes S3 GetObject NoSuchKey, S3 HeadObject NotFound (a HEAD has no error body), a 404, and ENOENT', () => {
    expect(isMissingObjectError(Object.assign(new Error('x'), { name: 'NoSuchKey' }))).toBe(true);
    expect(isMissingObjectError(Object.assign(new Error('x'), { name: 'NotFound' }))).toBe(true);
    expect(isMissingObjectError(Object.assign(new Error('x'), { $metadata: { httpStatusCode: 404 } }))).toBe(true);
    expect(isMissingObjectError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(true);
  });
  it('treats everything else as a storage failure', () => {
    expect(isMissingObjectError(Object.assign(new Error('x'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }))).toBe(false);
    expect(isMissingObjectError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(false);
    expect(isMissingObjectError(new Error('Failed to read file from S3: timeout'))).toBe(false);
    expect(isMissingObjectError(null)).toBe(false);
  });
});

describe('ExportAttachmentPlan (#699)', () => {
  it('streams every present attachment, STORE-compressed, deduplicated per archive path', async () => {
    const a = att('a1');
    const store = fakeStorage({ [a.filePath]: Buffer.from('PNGDATA') });
    const plan = new ExportAttachmentPlan(store, 'page:p', limits(), logger());
    const zip = new JSZip();
    zip.file('Page One.md', '# one');
    const child = zip.folder('Page One')!;
    plan.add(zip, '/files/a1/a1.png', a, page);
    plan.add(zip, '/files/a1/a1.png', a, page); // referenced twice from one folder: one entry
    plan.add(child, '/files/a1/a1.png', a, { id: 'page-2', title: 'Two' }); // another folder: its own entry
    expect(plan.declaredBytes).toBe(20);

    await plan.seal(zip);
    expect(store.exists).toHaveBeenCalledTimes(1); // one HEAD per storage object, not per entry
    expect(store.readStream).not.toHaveBeenCalled(); // nothing is read before the archive is generated
    expect(zip.files['/files/a1/a1.png'].options.compression).toBe('STORE');

    const back = await build(plan, zip);
    expect(await back.file('/files/a1/a1.png')!.async('string')).toBe('PNGDATA');
    // Written as 'Page One//files/…' exactly as upstream names it; JSZip's reader collapses the '//'.
    expect(zip.files['Page One//files/a1/a1.png']).toBeDefined();
    expect(await back.file('Page One/files/a1/a1.png')!.async('string')).toBe('PNGDATA');
    expect(back.file(MISSING_ATTACHMENTS_FILE)).toBeNull();
    expect(store.readStream).toHaveBeenCalledTimes(2);
  });

  it('refuses 422 export_too_large past the attachment budget, before any storage call', async () => {
    const store = fakeStorage({});
    const plan = new ExportAttachmentPlan(store, 'page:p', limits({ attachmentBytes: 100 }), logger());
    const zip = new JSZip();
    plan.add(zip, '/files/a1/x', att('a1', 60), page);
    plan.add(zip, '/files/a2/x', att('a2', '41'), page); // int8 may arrive as a string
    const err = await plan.seal(zip).catch((e) => e);
    expect(err).toBeInstanceOf(ExportTooLargeException);
    expect(err.getStatus()).toBe(422);
    expect(err.getResponse()).toMatchObject({ code: 'export_too_large' });
    expect(err.getResponse().message).toMatch(/Export without attachments, or export a smaller subtree/);
    expect(store.exists).not.toHaveBeenCalled();
    expect(Object.keys(zip.files)).toEqual([]);
  });

  it('counts an attachment once per archive path: the same file under two folders counts twice, twice in one folder once', async () => {
    const plan = new ExportAttachmentPlan(fakeStorage({}), 'page:p', limits({ attachmentBytes: 100 }), logger());
    const zip = new JSZip();
    plan.add(zip, '/files/a1/x', att('a1', 60), page);
    plan.add(zip, '/files/a1/x', att('a1', 60), page);
    await expect(plan.seal(zip)).resolves.toBeUndefined(); // 60 ≤ 100

    const plan2 = new ExportAttachmentPlan(fakeStorage({}), 'page:p', limits({ attachmentBytes: 100 }), logger());
    const zip2 = new JSZip();
    plan2.add(zip2, '/files/a1/x', att('a1', 60), page);
    plan2.add(zip2.folder('Child')!, '/files/a1/x', att('a1', 60), page);
    await expect(plan2.seal(zip2)).rejects.toBeInstanceOf(ExportTooLargeException); // 120 > 100
  });

  it('a NULL file_size counts 0 up front (the streamed-bytes backstop catches it)', async () => {
    const a = att('a1', null);
    const plan = new ExportAttachmentPlan(fakeStorage({ [a.filePath]: Buffer.alloc(300) }), 'page:p', limits({ attachmentBytes: 100 }), logger());
    const zip = new JSZip();
    plan.add(zip, '/files/a1/x', a, page);
    expect(plan.declaredBytes).toBe(0);
    await plan.seal(zip);
    const out = plan.stream(zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true }));
    out.on('data', () => undefined);
    const err = await new Promise((resolve) => out.once('error', resolve));
    expect(err).toBeInstanceOf(ExportTooLargeException);
  });

  it('refuses past the zip32 entry limit, counting the folders JSZip creates, before any storage call', async () => {
    const store = fakeStorage({});
    const plan = new ExportAttachmentPlan(store, 'page:p', limits({ maxEntries: 6 }), logger());
    const zip = new JSZip();
    zip.file('a.md', 'a');
    plan.add(zip, '/files/a1/x', att('a1'), page); // + '/files/', '/files/a1/', the file
    plan.add(zip, '/files/a2/x', att('a2'), page); // + '/files/a2/', the file  → 6, + the missing note → 7
    await expect(plan.seal(zip)).rejects.toMatchObject({ reason: 'entries' });
    expect(store.exists).not.toHaveBeenCalled();
  });

  it('a MISSING object: no entry (never an empty one), a WARN EXPORT_ATTACHMENT_MISSING, listed in missing-attachments.txt', async () => {
    const here = att('a1');
    const gone = att('a2', 10, 'report.pdf');
    const headNotFound = att('a3', 10, 'deck.key');
    const store = fakeStorage(
      { [here.filePath]: Buffer.from('ok'), [headNotFound.filePath]: Buffer.from('never read') },
      (p) => (p === headNotFound.filePath ? Object.assign(new Error('UnknownError'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }) : null),
    );
    const log = logger();
    const plan = new ExportAttachmentPlan(store, 'space:s1', limits(), log);
    const zip = new JSZip();
    zip.file('Home.md', '# home');
    plan.add(zip, '/files/a1/a1.png', here, page);
    plan.add(zip, '/files/a2/report.pdf', gone, { id: 'page-9', title: 'Quarterly\nnumbers' });
    plan.add(zip, '/files/a3/deck.key', headNotFound, page);
    await plan.seal(zip);

    expect(zip.files['/files/a2/report.pdf']).toBeUndefined();
    expect(zip.files['/files/a3/deck.key']).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/^EXPORT_ATTACHMENT_MISSING export=space:s1 page=page-9 attachment=a2: /));
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/^EXPORT_ATTACHMENT_MISSING export=space:s1 page=page-1 attachment=a3: /));

    const back = await build(plan, zip);
    const note = await back.file(MISSING_ATTACHMENTS_FILE)!.async('string');
    expect(note).toContain('/files/a2/report.pdf\tQuarterly numbers');
    expect(note).toContain('/files/a3/deck.key\tPage One');
    expect(back.file('/files/a2/report.pdf')).toBeNull();
    expect(await back.file('/files/a1/a1.png')!.async('string')).toBe('ok');
    expect(await back.file('Home.md')!.async('string')).toBe('# home');
    expect(store.readStream).toHaveBeenCalledTimes(1);
  });

  it('any OTHER storage error fails the export with a 503 before any byte, logged EXPORT_ABORTED phase=precheck', async () => {
    const a = att('a1');
    const store = fakeStorage({ [a.filePath]: Buffer.from('x') }, () =>
      Object.assign(new Error('Access Denied for bucket secret-bucket'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }),
    );
    const log = logger();
    const plan = new ExportAttachmentPlan(store, 'page:p', limits(), log);
    const zip = new JSZip();
    plan.add(zip, '/files/a1/x', a, page);
    const err = await plan.seal(zip).catch((e) => e);
    expect(err).toBeInstanceOf(ExportStorageException);
    expect(err.getStatus()).toBe(503);
    expect(JSON.stringify(err.getResponse())).not.toContain('secret-bucket'); // the storage error is logged, never sent
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/^EXPORT_ABORTED reason=storage_error export=page:p phase=precheck: Access Denied/));
    expect(zip.files['/files/a1/x']).toBeUndefined();
  });

  it('checks existence at most 8 at a time', async () => {
    let live = 0;
    let max = 0;
    const store = {
      exists: jest.fn(async () => {
        live++;
        max = Math.max(max, live);
        await new Promise((r) => setTimeout(r, 5));
        live--;
        return true;
      }),
      readStream: jest.fn(),
    };
    const plan = new ExportAttachmentPlan(store, 'space:s', limits(), logger());
    const zip = new JSZip();
    for (let i = 0; i < 40; i++) plan.add(zip, `/files/a${i}/x`, att(`a${i}`), page);
    await plan.seal(zip);
    expect(store.exists).toHaveBeenCalledTimes(40);
    expect(max).toBe(8);
  });

  it('a HUNG exists() (the S3 client sets no request timeout) fails 503 within EXPORT_STORAGE_TIMEOUT_MS, not never', async () => {
    let finish: (v: boolean) => void = () => undefined;
    const store = { exists: jest.fn(() => new Promise<boolean>((r) => (finish = r))), readStream: jest.fn() };
    const log = logger();
    const plan = new ExportAttachmentPlan(store, 'page:p', limits({ storageTimeoutMs: 100 }), log);
    const zip = new JSZip();
    plan.add(zip, '/files/a1/x', att('a1'), page);
    const t0 = Date.now();
    const err = await plan.seal(zip).catch((e) => e);
    expect(err).toBeInstanceOf(ExportStorageException);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringMatching(/^EXPORT_ABORTED reason=storage_error export=page:p phase=precheck: exists\(\) did not answer within 100 ms/),
    );
    finish(false); // #716: the hung HEAD holds its process-wide slot until it settles; let it, so no later spec inherits it
    await new Promise((r) => setImmediate(r));
  });
});

describe('withStorageTimeout', () => {
  it('answers in time: the value; too late: a StorageTimeoutError, and the late value goes to onLate', async () => {
    await expect(withStorageTimeout(Promise.resolve(1), 50, 'x')).resolves.toBe(1);
    let resolveLate!: (v: string) => void;
    const late = jest.fn();
    const p = withStorageTimeout(new Promise<string>((r) => (resolveLate = r)), 20, 'open', late);
    await expect(p).rejects.toBeInstanceOf(StorageTimeoutError);
    resolveLate('stream');
    await new Promise((r) => setTimeout(r, 5));
    expect(late).toHaveBeenCalledWith('stream');
  });

  it('a storage timeout is a failure, never "no such object"', () => {
    expect(isMissingObjectError(new StorageTimeoutError('exists()', 10))).toBe(false);
  });
});

describe('#716 M4: storage HEADs are bounded across every export in the process', () => {
  /** A storage whose every exists() waits until `releaseAll()`; counts what is in flight. */
  function gatedStorage() {
    let inFlight = 0;
    let max = 0;
    const waiting: Array<() => void> = [];
    let open = false;
    const exists = jest.fn(async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      if (!open) await new Promise<void>((r) => waiting.push(r));
      inFlight--;
      return true;
    });
    return {
      exists,
      readStream: jest.fn(async () => Readable.from([Buffer.from('x')])),
      max: () => max,
      releaseAll: () => {
        open = true;
        waiting.splice(0).forEach((r) => r());
      },
    };
  }
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };

  it('three exports at 8 each never have more than 16 HEADs — or 16 storage timers — in flight', async () => {
    const storage = gatedStorage();
    const limitsModule = jest.requireActual('./export-limits') as typeof import('./export-limits');
    const timed = jest.spyOn(limitsModule, 'withStorageTimeout');
    const plans = [0, 1, 2].map((n) => {
      const plan = new ExportAttachmentPlan(storage, `page:p${n}`, limits(), logger());
      const zip = new JSZip();
      for (let i = 0; i < 10; i++) plan.add(zip, `/files/a${n}-${i}/x.png`, att(`a${n}-${i}`), page);
      return plan.seal(zip);
    });
    await settle();
    expect(storage.exists).toHaveBeenCalledTimes(16); // 24 wanted to run (3 × 8)
    expect(storage.max()).toBe(16);
    // The storage timeout starts only once a HEAD holds its slot: time queued for a slot is never a storage 503.
    expect(timed).toHaveBeenCalledTimes(16);
    storage.releaseAll();
    await Promise.all(plans);
    expect(storage.exists).toHaveBeenCalledTimes(30);
    expect(storage.max()).toBeLessThanOrEqual(16);
    timed.mockRestore();
  });

  it('#716: a HEAD that outlives its storage timeout keeps its slot until it settles (the socket is still busy)', async () => {
    const storage = gatedStorage();
    // Two exports start 16 HEADs that hang; each export gives up on them at its 50 ms storage timeout (503).
    const failed = [0, 1].map((n) => {
      const plan = new ExportAttachmentPlan(storage, `page:slow${n}`, limits({ storageTimeoutMs: 50 }), logger());
      const zip = new JSZip();
      for (let i = 0; i < 8; i++) plan.add(zip, `/files/s${n}-${i}/x.png`, att(`s${n}-${i}`), page);
      return plan.seal(zip).catch((e) => e);
    });
    for (const f of failed) await expect(f).resolves.toBeInstanceOf(ExportStorageException);
    expect(storage.exists).toHaveBeenCalledTimes(16);
    // Those 16 HEADs are still running against storage: a third export starts none until they settle.
    const next = new ExportAttachmentPlan(storage, 'page:next', limits(), logger());
    const zip2 = new JSZip();
    for (let i = 0; i < 8; i++) next.add(zip2, `/files/n-${i}/x.png`, att(`n-${i}`), page);
    const sealing = next.seal(zip2);
    await settle();
    expect(storage.exists).toHaveBeenCalledTimes(16);
    expect(storage.max()).toBe(16);
    storage.releaseAll();
    await sealing;
    expect(storage.exists).toHaveBeenCalledTimes(24);
  });

  it('#716: no HEAD slot in time (not a build stop) is a busy engine (503 engine_busy), not a storage error', async () => {
    jest.useFakeTimers();
    try {
      const storage = gatedStorage();
      const slow = limits({ storageTimeoutMs: 300_000 }); // the holders' HEADs neither time out nor hit the backstop here
      // Two exports take all 16 process-wide slots with HEADs that hang until released.
      const holders = [0, 1].map((n) => {
        const plan = new ExportAttachmentPlan(storage, `page:hold${n}`, slow, logger());
        const z = new JSZip();
        for (let i = 0; i < 8; i++) plan.add(z, `/files/g${n}-${i}/x.png`, att(`g${n}-${i}`), page);
        return plan.seal(z);
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(storage.max()).toBe(16);
      const log = logger();
      const waiter = new ExportAttachmentPlan(storage, 'page:w', limits(), log);
      const z = new JSZip();
      waiter.add(z, '/files/w/x.png', att('w'), page);
      const err = waiter.seal(z).catch((e) => e);
      await jest.advanceTimersByTimeAsync(60_001); // EXISTS_SLOT_MAX_WAIT_MS outside a build
      const e = await err;
      expect(e).not.toBeInstanceOf(ExportStorageException);
      expect(e.getStatus()).toBe(503);
      expect(e.getResponse()).toMatchObject({ code: 'engine_busy' });
      expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/^EXPORT_BUSY scope=storage_heads export=page:w /));
      expect(log.error).not.toHaveBeenCalled();
      storage.releaseAll();
      await Promise.all(holders);
    } finally {
      jest.useRealTimers();
    }
  });
});
