import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  HttpCode,
  Injectable,
  Logger,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { FastifyReply } from 'fastify';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough, Readable } from 'node:stream';
import * as JSZip from 'jszip';
import { ExportAttachmentPlan } from '../../editor-compat/export/export-attachment-plan';
import { EXPORT_LIMIT_DEFAULTS, ExportTooLargeException } from '../../editor-compat/export/export-limits';
import { EXPORT_ADMISSION } from './export-admission.interceptor';
import { ExportAdmissionModule } from './export-admission.module';

/**
 * #699 — export admission + the bounded export stream, composed on a REAL Nest + Fastify server (not inject: the
 * release semantics depend on the raw response's 'close', and the post-first-byte failure on a real socket). The
 * probe controller is named and shaped like the real one (`ExportController.exportPage` / `exportSpace`, `@Res()`,
 * `res.send(stream)`), and the module under test is the real `ExportAdmissionModule`.
 */

type Scenario = 'hold' | 'ok' | 'too-large' | 'precheck-error' | 'midstream-error' | 'slow-handler' | 'hung-exists';
type ExportBody = { key: string; scenario: Scenario; includeChildren?: boolean; includeAttachments?: boolean };

/** Held sources by request key: each sends one chunk, then waits for `release(key)`. */
const held = new Map<string, PassThrough>();
const release = (key: string) => held.get(key)?.end();

function storageFor(body: ExportBody) {
  return {
    exists: async () => {
      if (body.scenario === 'precheck-error') throw Object.assign(new Error('AccessDenied'), { name: 'AccessDenied' });
      if (body.scenario === 'hung-exists') return new Promise<boolean>(() => undefined); // a HEAD that never answers
      return true;
    },
    readStream: async (): Promise<Readable> => {
      if (body.scenario === 'hold') {
        const s = new PassThrough();
        s.write(Buffer.alloc(256 * 1024, 1));
        held.set(body.key, s);
        return s;
      }
      if (body.scenario === 'midstream-error') {
        const s = new PassThrough();
        s.write(Buffer.alloc(256 * 1024, 2));
        setTimeout(() => s.destroy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), 30);
        return s;
      }
      return Readable.from([Buffer.from('file')]);
    },
  };
}

/** Mimics JwtAuthGuard: the verified principal from a header. */
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    req.user = { user: { id: String(req.headers['x-user'] ?? 'user-1') } };
    return true;
  }
}

/** Handlers still working (the pages being converted), by request key: each waits for `finishWork(key)`. */
const working = new Map<string, () => void>();
const finishWork = (key: string) => working.get(key)?.();

async function exportZip(body: ExportBody, res: FastifyReply): Promise<void> {
  if (body.scenario === 'too-large') throw new ExportTooLargeException('attachments', 10, 1);
  if (body.scenario === 'slow-handler') await new Promise<void>((r) => working.set(body.key, r));
  const plan = new ExportAttachmentPlan(storageFor(body), `space:${body.key}`, { ...EXPORT_LIMIT_DEFAULTS, storageTimeoutMs: 200 }, { warn: () => undefined, error: () => undefined });
  const zip = new JSZip();
  zip.file('Home.md', '# home');
  plan.add(zip, '/files/a1/f.bin', { id: 'a1', fileName: 'f.bin', filePath: 'p/f.bin', fileSize: 10 }, { id: 'home', title: 'Home' });
  await plan.seal(zip);
  res.headers({ 'Content-Type': 'application/zip' });
  res.send(plan.stream(zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE' })));
}

@Controller()
class ExportController {
  @UseGuards(FakeAuthGuard)
  @HttpCode(200)
  @Post('pages/export')
  async exportPage(@Body() body: ExportBody, @Res() res: FastifyReply) {
    if (!body.includeChildren && !body.includeAttachments) {
      res.send('# a single page'); // the /v1 export job's shape: a plain file
      return;
    }
    await exportZip(body, res);
  }

  @UseGuards(FakeAuthGuard)
  @HttpCode(200)
  @Post('spaces/export')
  async exportSpace(@Body() body: ExportBody, @Res() res: FastifyReply) {
    await exportZip(body, res);
  }
}

describe('export admission on a real server (#699)', () => {
  let app: NestFastifyApplication;
  let port: number;
  const open: http.ClientRequest[] = [];

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      imports: [ExportAdmissionModule],
      controllers: [ExportController],
      providers: [FakeAuthGuard],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterEach(() => {
    for (const k of [...held.keys()]) release(k);
    held.clear();
    for (const k of [...working.keys()]) finishWork(k);
    working.clear();
    for (const r of open.splice(0)) r.destroy();
  });

  afterAll(async () => {
    await app?.close();
    jest.restoreAllMocks();
  });

  type Answer = { status: number; headers: http.IncomingHttpHeaders; res: http.IncomingMessage; req: http.ClientRequest };

  /** POST and resolve once the response head arrives (the body keeps streaming). */
  function post(path: string, body: ExportBody, user = 'user-1'): Promise<Answer> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request(
        { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'x-user': user, 'content-length': Buffer.byteLength(payload) } },
        (res) => resolve({ status: res.statusCode ?? 0, headers: res.headers, res, req }),
      );
      open.push(req);
      req.once('error', reject);
      req.end(payload);
    });
  }

  /** Read the whole body; resolves `aborted: true` when the connection dies before a clean end. */
  function drain(a: Answer): Promise<{ body: Buffer; aborted: boolean }> {
    return new Promise((resolve) => {
      const parts: Buffer[] = [];
      let settled = false;
      const done = (aborted: boolean) => {
        if (!settled) {
          settled = true;
          resolve({ body: Buffer.concat(parts), aborted });
        }
      };
      a.res.on('data', (c: Buffer) => parts.push(c));
      a.res.once('end', () => done(!a.res.complete));
      a.res.once('aborted', () => done(true));
      a.res.once('error', () => done(true));
      a.res.once('close', () => done(!a.res.complete));
    });
  }

  /** Poll until a governed request for `user` is admitted (the earlier slot was released), or fail. */
  async function admittedWithin(user: string, ms = 2000): Promise<Answer> {
    const deadline = Date.now() + ms;
    for (;;) {
      const a = await post('/spaces/export', { key: `probe-${user}-${Date.now()}`, scenario: 'ok' }, user);
      if (a.status === 200) {
        await drain(a);
        return a;
      }
      await drain(a);
      if (Date.now() > deadline) throw new Error(`still refused (${a.status}) after ${ms} ms`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it('one export per principal: a second concurrent one gets 503 engine_busy + Retry-After; released when it ends', async () => {
    const first = await post('/spaces/export', { key: 'p1', scenario: 'hold' });
    expect(first.status).toBe(200);
    const second = await post('/spaces/export', { key: 'p1b', scenario: 'ok' });
    expect(second.status).toBe(503);
    expect(second.headers['retry-after']).toBe(String(EXPORT_ADMISSION.retryAfterSeconds));
    expect(JSON.parse((await drain(second)).body.toString())).toMatchObject({ code: 'engine_busy' });
    // a page export that builds a zip counts against the same principal
    const zipPage = await post('/pages/export', { key: 'p1c', scenario: 'ok', includeAttachments: true });
    expect(zipPage.status).toBe(503);
    await drain(zipPage);

    // the handler has returned long ago (@Res); the slot is still held while the archive streams
    await new Promise((r) => setTimeout(r, 50));
    expect((await post('/spaces/export', { key: 'p1d', scenario: 'ok' })).status).toBe(503);

    const reading = drain(first);
    release('p1');
    const done = await reading;
    expect(done.aborted).toBe(false);
    const zip = await JSZip.loadAsync(done.body);
    expect(Object.keys(zip.files)).toContain('/files/a1/f.bin');
    await admittedWithin('user-1');
  });

  it('the single-page export without children or attachments (the /v1 export job) is never throttled', async () => {
    const holding = await post('/spaces/export', { key: 'p2', scenario: 'hold' });
    expect(holding.status).toBe(200);
    const single = await post('/pages/export', { key: 'p2b', scenario: 'ok', includeChildren: false, includeAttachments: false });
    expect(single.status).toBe(200);
    expect((await drain(single)).body.toString()).toBe('# a single page');
  });

  it(`at most ${EXPORT_ADMISSION.global} per process: the next principal gets 503 until one ends`, async () => {
    const holders: Answer[] = [];
    for (let i = 0; i < EXPORT_ADMISSION.global; i++) {
      const a = await post('/spaces/export', { key: `g${i}`, scenario: 'hold' }, `user-g${i}`);
      expect(a.status).toBe(200);
      holders.push(a);
    }
    const refused = await post('/spaces/export', { key: 'gx', scenario: 'ok' }, 'user-gx');
    expect(refused.status).toBe(503);
    await drain(refused);

    const reading = drain(holders[0]);
    release('g0');
    await reading;
    await admittedWithin('user-gx');
  });

  it('a client that goes away releases its slot and the open storage object', async () => {
    const a = await post('/spaces/export', { key: 'p3', scenario: 'hold' }, 'user-3');
    expect(a.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    const source = held.get('p3')!;
    expect(source.destroyed).toBe(false);
    a.req.destroy(); // the browser tab closes
    await admittedWithin('user-3');
    expect(source.destroyed).toBe(true);
  });

  it('a client that leaves while the handler is still working does NOT free the slot until the handler finishes', async () => {
    const payload = JSON.stringify({ key: 'p7', scenario: 'slow-handler' });
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/spaces/export',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user': 'user-7', 'content-length': Buffer.byteLength(payload) },
    });
    req.on('error', () => undefined);
    req.end(payload);
    for (let i = 0; i < 100 && !working.has('p7'); i++) await new Promise((r) => setTimeout(r, 10));
    expect(working.has('p7')).toBe(true);
    req.destroy(); // the response closes while the pages are still being converted
    await new Promise((r) => setTimeout(r, 50));
    const refused = await post('/spaces/export', { key: 'p7b', scenario: 'ok' }, 'user-7');
    expect(refused.status).toBe(503); // the work is still running: the slot is still held
    await drain(refused);
    finishWork('p7');
    await admittedWithin('user-7');
  });

  it('a refused export (422 from the handler) releases its slot at once', async () => {
    const a = await post('/spaces/export', { key: 'p4', scenario: 'too-large' }, 'user-4');
    expect(a.status).toBe(422);
    expect(JSON.parse((await drain(a)).body.toString())).toMatchObject({ code: 'export_too_large' });
    await admittedWithin('user-4', 500);
  });

  it('a storage error before the first byte is a 503 JSON answer, and the slot is released', async () => {
    const a = await post('/spaces/export', { key: 'p5', scenario: 'precheck-error' }, 'user-5');
    expect(a.status).toBe(503);
    const body = JSON.parse((await drain(a)).body.toString());
    expect(body).toMatchObject({ code: 'export_storage_unavailable' });
    expect(JSON.stringify(body)).not.toContain('AccessDenied');
    await admittedWithin('user-5', 500);
  });

  it('a HUNG storage check answers 503 within EXPORT_STORAGE_TIMEOUT_MS and releases the slot', async () => {
    const t0 = Date.now();
    const a = await post('/spaces/export', { key: 'p8', scenario: 'hung-exists' }, 'user-8');
    expect(a.status).toBe(503);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(JSON.parse((await drain(a)).body.toString())).toMatchObject({ code: 'export_storage_unavailable' });
    await admittedWithin('user-8', 500);
  });

  it('a storage error after the first byte destroys the connection: never a clean, short 200', async () => {
    const a = await post('/spaces/export', { key: 'p6', scenario: 'midstream-error' }, 'user-6');
    expect(a.status).toBe(200); // the head was already sent
    const done = await drain(a);
    expect(done.aborted).toBe(true);
    await expect(JSZip.loadAsync(done.body)).rejects.toBeTruthy(); // what arrived is not a valid archive
    await admittedWithin('user-6');
  });
});
