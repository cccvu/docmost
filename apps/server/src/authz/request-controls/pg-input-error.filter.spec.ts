import { Controller, Get, Headers, ServiceUnavailableException } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import * as postgres from 'postgres';
import { PgInputErrorFilter, isUnstorableInputError } from './pg-input-error.filter';
import { StorableTextModule } from './storable-text.module';
import { RetryAfterModule } from './retry-after.module';

/**
 * #781 (ADR 0036): the backstop behind the storable-text interceptor. A Postgres refusal of the request's own text —
 * U+0000 in jsonb (22P05) or text (22021), a lone surrogate in jsonb (22P02 "invalid input syntax for type json") —
 * is the caller's input, so 400 `invalid_characters`, not a 500 the platform renders "may have been applied". The
 * interceptor cannot see these when the bad string is ENCODED in the body: a comment's `content` is a JSON string the
 * service parses, so `"\\u0000"` in it only becomes NUL inside the handler.
 *
 * Everything else falls through to Nest's default handling unchanged: a 22P02 about a uuid, an integer, an enum is a
 * malformed id (upstream answers it 500 today, and this issue does not change that), and every other SQLSTATE.
 */
const PostgresError = (postgres as unknown as { PostgresError: new (x: object) => Error & { code: string } })
  .PostgresError;
const pgError = (code: string, message: string, detail?: string) =>
  new PostgresError({ code, message, severity: 'ERROR', ...(detail ? { detail } : {}) });

/** The messages Postgres 18 writes (lc_messages=C), as captured by pg-input-error.pg.spec.ts. */
const PG = {
  jsonbNul: () => pgError('22P05', 'unsupported Unicode escape sequence', '\\u0000 cannot be converted to text.'),
  textNul: () => pgError('22021', 'invalid byte sequence for encoding "UTF8": 0x00'),
  jsonbLoneSurrogate: () =>
    pgError('22P02', 'invalid input syntax for type json', 'Unicode low surrogate must follow a high surrogate.'),
  uuid: () => pgError('22P02', 'invalid input syntax for type uuid: "nope"'),
  integer: () => pgError('22P02', 'invalid input syntax for type integer: "x"'),
  unique: () => pgError('23505', 'duplicate key value violates unique constraint "pages_pkey"'),
};

describe('isUnstorableInputError (#781)', () => {
  it.each([
    ['22P05 (NUL in jsonb)', PG.jsonbNul(), true],
    ['22021 (NUL in text)', PG.textNul(), true],
    ['22P02 about json (a lone surrogate in jsonb)', PG.jsonbLoneSurrogate(), true],
    ['22P02 about a uuid', PG.uuid(), false],
    ['22P02 about an integer', PG.integer(), false],
    ['23505', PG.unique(), false],
  ])('%s → %s', (_n, err, expected) => {
    expect(isUnstorableInputError(err)).toBe(expected);
  });

  it('22P02 counts only when the message or detail is about json or Unicode', () => {
    expect(isUnstorableInputError(pgError('22P02', 'invalid input syntax for type jsonb'))).toBe(true);
    expect(isUnstorableInputError(pgError('22P02', 'invalid input syntax', 'Unicode escape values cannot be used'))).toBe(true);
    expect(isUnstorableInputError(pgError('22P02', 'invalid input value for enum x: "y"'))).toBe(false);
  });

  it('only a real PostgresError: a plain Error carrying the same code is not the database talking', () => {
    expect(isUnstorableInputError(Object.assign(new Error('x'), { code: '22P05' }))).toBe(false);
  });
});

@Controller()
class ProbeController {
  @Get('pg') pg(@Headers('x-probe') probe: keyof typeof PG): never {
    throw PG[probe]();
  }
  @Get('plain') plain(): never {
    throw Object.assign(new Error('not the database'), { code: '22P05' });
  }
  @Get('busy') busy(): never {
    throw new ServiceUnavailableException('busy');
  }
}

async function boot(imports: unknown[]): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ imports: imports as never[], controllers: [ProbeController] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe('PgInputErrorFilter over HTTP (#781)', () => {
  let app: NestFastifyApplication;
  let bare: NestFastifyApplication;
  beforeAll(async () => {
    // Registered beside RetryAfterModule exactly as AuthzModule does: the two filters' @Catch types do not overlap.
    app = await boot([RetryAfterModule, StorableTextModule]);
    bare = await boot([]);
  });
  afterAll(async () => {
    await app.close();
    await bare.close();
  });
  const get = (a: NestFastifyApplication, url: string, probe?: string) =>
    a.inject({ method: 'GET', url, headers: probe ? { 'x-probe': probe } : {} });

  it.each(['jsonbNul', 'textNul', 'jsonbLoneSurrogate'])(
    '%s: 400 invalid_characters, no Retry-After, nothing from the database echoed',
    async (probe) => {
      const res = await get(app, '/pg', probe);
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body).toEqual({ message: expect.stringContaining('NUL'), code: 'invalid_characters' });
      expect(res.body).not.toMatch(/surrogate must|0x00|UTF8/);
      expect(res.headers['retry-after']).toBeUndefined();
    },
  );

  it.each(['uuid', 'integer', 'unique'])('%s: falls through to Nest’s default, byte for byte', async (probe) => {
    const res = await get(app, '/pg', probe);
    const control = await get(bare, '/pg', probe);
    expect(res.statusCode).toBe(500);
    expect(res.statusCode).toBe(control.statusCode);
    expect(res.body).toBe(control.body);
  });

  it('a plain Error with a pg-like code is not caught: the default 500', async () => {
    const res = await get(app, '/plain');
    expect(res.statusCode).toBe(500);
    expect(res.body).toBe((await get(bare, '/plain')).body);
  });

  it('RetryAfterFilter still owns every 503 (no overlap, whatever the order)', async () => {
    const res = await get(app, '/busy');
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toMatch(/^[2-5]$/);
  });

  it('control: without the module, the same NUL refusal is a 500', async () => {
    const res = await get(bare, '/pg', 'jsonbNul');
    expect(res.statusCode).toBe(500);
  });

  it('re-throws outside HTTP (what Nest does there without a filter)', () => {
    const e = PG.jsonbNul();
    expect(() => new PgInputErrorFilter().catch(e as never, { getType: () => 'ws' } as never)).toThrow(e);
  });
});
