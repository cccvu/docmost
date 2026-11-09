import {
  Body,
  CallHandler,
  Controller,
  ExecutionContext,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  ValidationPipe,
} from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import fastifyMultipart from '@fastify/multipart';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lastValueFrom, of } from 'rxjs';
import { AuthzModule } from '../authz.module';
import {
  findUnstorableText,
  InvalidCharactersException,
  isJsonContentType,
  STORABLE_TEXT_MAX_VALUES,
} from './storable-text';
import { StorableTextInterceptor } from './storable-text.interceptor';
import { StorableTextModule } from './storable-text.module';
import { PgInputErrorFilter } from './pg-input-error.filter';

/**
 * #781 (ADR 0036): Postgres refuses U+0000 (jsonb 22P05, text 22021) and a lone UTF-16 surrogate (jsonb 22P02). A
 * request string carrying one used to reach the database and come back as a 500 — after any earlier step of the same
 * request had already applied (the `/v1` conditional update writes content to the live document, then the title).
 * The interceptor refuses it before the handler: 400 `invalid_characters`.
 */
const HIGH = '\ud83d';
const LOW = '\ude00';
const EMOJI = '😀';

describe('findUnstorableText (#781)', () => {
  it.each([
    ['NUL in a string', { title: 'a\0b' }, 'title'],
    ['a lone high surrogate', { title: `x${HIGH}` }, 'title'],
    ['a lone low surrogate', { title: `${LOW}y` }, 'title'],
    ['a reversed pair', { t: `${LOW}${HIGH}` }, 't'],
    ['NUL deep in an array', { content: { content: [{ text: 'ok' }, { text: '\0' }] } }, 'content.content[1].text'],
    ['NUL in an object KEY', { attrs: { 'k\0': 'v' } }, 'attrs.k�'],
    ['a lone surrogate in a key', { [HIGH]: 1 }, '�'],
    ['a bare string', 'a\0', ''],
    ['NUL in a top-level array', ['ok', '\0'], '[1]'],
  ])('finds %s, naming where', (_name, value, path) => {
    expect(findUnstorableText(value)).toEqual({ kind: 'invalid', path });
  });

  it('accepts a paired surrogate (an emoji), other control characters, numbers, booleans and null', () => {
    const clean = {
      title: `a${EMOJI}b`,
      ctl: '\u0001\t\n\u001f\u007f',
      n: 1,
      b: true,
      z: null,
      arr: [EMOJI, { [EMOJI]: ['x'] }],
      empty: '',
    };
    expect(findUnstorableText(clean)).toBeNull();
    expect(findUnstorableText(undefined)).toBeNull();
    expect(findUnstorableText(42)).toBeNull();
  });

  it('an explicit-stack walk: a 100k-deep body is walked to the bottom without a RangeError', () => {
    let v: unknown = { text: 'bottom\0' };
    for (let i = 0; i < 100_000; i++) v = { content: [v] };
    let found: unknown;
    expect(() => (found = findUnstorableText(v))).not.toThrow();
    expect(found).toMatchObject({ kind: 'invalid' });
    expect((found as { path: string }).path.length).toBeLessThanOrEqual(256); // the path is capped
    let clean: unknown = 'bottom';
    for (let i = 0; i < 100_000; i++) clean = [clean];
    expect(findUnstorableText(clean)).toBeNull();
  });

  it('is bounded: more values than the budget is too_complex (fail closed), never a partial pass', () => {
    expect(STORABLE_TEXT_MAX_VALUES).toBeGreaterThanOrEqual(1_000_000);
    const many = Array.from({ length: 11 }, () => 'x');
    expect(findUnstorableText(many, 10)).toEqual({ kind: 'too_complex' });
    expect(findUnstorableText(many, 12)).toBeNull();
  });

  it('never walks into a non-plain object (a Buffer, a stream): JSON never makes one', () => {
    const buf = Buffer.from([0, 0xd8]);
    class Part {
      value = 'a\0';
    }
    expect(findUnstorableText({ buf, part: new Part() })).toBeNull();
  });
});

describe('isJsonContentType (#781)', () => {
  it.each([
    ['application/json', true],
    ['application/json; charset=utf-8', true],
    ['Application/JSON', true],
    ['application/scim+json', true],
    ['application/merge-patch+json;charset=utf-8', true],
    ['multipart/form-data; boundary=x', false],
    ['text/plain', false],
    ['application/jsonx', false],
    ['application/x-www-form-urlencoded', false],
    [undefined, false],
  ])('%s → %s', (ct, expected) => {
    expect(isJsonContentType(ct)).toBe(expected);
  });
});

describe('InvalidCharactersException (#781)', () => {
  it('is a 400 with the stable code, the fork’s 400 shape, and never echoes the value', () => {
    const e = new InvalidCharactersException('body.title');
    expect(e.getStatus()).toBe(400);
    expect(e.getResponse()).toEqual({
      message: expect.stringContaining('NUL'),
      code: 'invalid_characters',
      field: 'body.title',
    });
  });
});

const handled: string[] = [];

@Controller('probe')
class ProbeController {
  @HttpCode(200)
  @Post('json/:slug')
  json(@Param('slug') slug: string, @Query('q') q: string | undefined, @Body() body: unknown) {
    handled.push(`json:${slug}`);
    return { slug, q, body };
  }

  @HttpCode(200)
  @Post('upload')
  async upload(@Req() req: any) {
    // Reads the multipart field the way an upload handler would: after the interceptor, from the stream.
    const file = await req.file();
    const field = file?.fields?.title?.value as string | undefined;
    handled.push('upload');
    return { hasNul: !!field?.includes('\0') };
  }

  @HttpCode(200)
  @Post('text')
  text(@Body() body: unknown) {
    handled.push('text');
    return { type: typeof body };
  }
}

async function boot(withModule: boolean): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: withModule ? [StorableTextModule] : [],
    controllers: [ProbeController],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.register(fastifyMultipart as never);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, stopAtFirstError: true, transform: true }));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

const postJson = (app: NestFastifyApplication, url: string, raw: string) =>
  app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: raw });

describe('StorableTextInterceptor over HTTP (#781)', () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await boot(true);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    handled.length = 0;
  });

  it('a clean JSON body, query and param reach the handler', async () => {
    const res = await postJson(app, '/probe/json/s1?q=hello', JSON.stringify({ title: `ok ${EMOJI}` }));
    expect(res.statusCode).toBe(200);
    expect(handled).toEqual(['json:s1']);
  });

  it.each([
    ['NUL in a body string', JSON.stringify({ title: 'a\0b' }), 'body.title'],
    ['an escaped NUL (\\u0000) in a body string', '{"title":"a\\u0000b"}', 'body.title'],
    ['an escaped lone surrogate in a body string', '{"content":{"text":"x\\ud83d"}}', 'body.content.text'],
    ['NUL in a body key', '{"attrs":{"k\\u0000":1}}', 'body.attrs.k�'],
  ])('%s: 400 invalid_characters, the handler never runs', async (_n, raw, field) => {
    const res = await postJson(app, '/probe/json/s1', raw);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ message: expect.any(String), code: 'invalid_characters', field });
    expect(res.body).not.toContain('\\u0000');
    expect(handled).toEqual([]);
  });

  it('NUL in a query string or a path parameter (%00): 400, the handler never runs', async () => {
    const q = await postJson(app, '/probe/json/s1?q=a%00b', '{}');
    expect(q.statusCode).toBe(400);
    expect(JSON.parse(q.body)).toMatchObject({ code: 'invalid_characters', field: 'query.q' });
    const p = await postJson(app, '/probe/json/a%00b', '{}');
    expect(p.statusCode).toBe(400);
    expect(JSON.parse(p.body)).toMatchObject({ code: 'invalid_characters', field: 'params.slug' });
    expect(handled).toEqual([]);
  });

  it('a multipart upload is not inspected (its file bytes are binary): the handler runs', async () => {
    const boundary = 'b781';
    const payload =
      `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\na\0b\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.bin"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n\0\0ÿ\r\n--${boundary}--\r\n`;
    const res = await app.inject({
      method: 'POST',
      url: '/probe/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(handled).toEqual(['upload']);
  });

  it('a non-JSON body (text/plain) is not inspected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/probe/text',
      headers: { 'content-type': 'text/plain' },
      payload: 'a\0b',
    });
    expect(res.statusCode).toBe(200);
    expect(handled).toEqual(['text']);
  });

  it('control: without the module the same NUL body reaches the handler', async () => {
    const bare = await boot(false);
    try {
      const res = await postJson(bare, '/probe/json/s1', JSON.stringify({ title: 'a\0b' }));
      expect(res.statusCode).toBe(200);
      expect(handled).toEqual(['json:s1']);
    } finally {
      await bare.close();
    }
  });
});

describe('StorableTextInterceptor outside HTTP (#781)', () => {
  it('passes a websocket / rpc context through untouched (the collab socket never reaches it; socket.io may)', async () => {
    const i = new StorableTextInterceptor();
    const ctx = { getType: () => 'ws' } as unknown as ExecutionContext;
    const next: CallHandler = { handle: () => of('handled') };
    await expect(lastValueFrom(i.intercept(ctx, next))).resolves.toBe('handled');
  });
});

describe('StorableTextModule wiring (#781)', () => {
  it('is registered from AuthzModule (in the graph via database.module — no upstream file registers it)', () => {
    const imports = Reflect.getMetadata('imports', AuthzModule) as unknown[];
    expect(imports).toContain(StorableTextModule);
    const providers = Reflect.getMetadata('providers', StorableTextModule) as Array<{ provide: unknown; useClass: unknown }>;
    expect(providers).toEqual([
      { provide: 'APP_INTERCEPTOR', useClass: StorableTextInterceptor },
      { provide: 'APP_FILTER', useClass: PgInputErrorFilter },
    ]);
    const app = readFileSync(join(__dirname, '..', '..', 'app.module.ts'), 'utf8');
    expect(app).not.toMatch(/StorableText|PgInputError/);
  });
});
