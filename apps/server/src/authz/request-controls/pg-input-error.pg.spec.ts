import * as postgres from 'postgres';
import { Kysely } from 'kysely';
import { Body, Controller, HttpCode, Post, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

// The comment service imports the gateway, whose runtime require pulls the collab WebSocket stack (lib0 ESM).
jest.mock('../../collaboration/collaboration.gateway', () => ({ CollaborationGateway: class CollaborationGateway {} }));

import { CommentRepo } from '@docmost/db/repos/comment/comment.repo';
import { CommentService } from '../../core/comment/comment.service';
import { CreateCommentDto } from '../../core/comment/dto/create-comment.dto';
import { PG_URL, uuid, mkReadModelPg, bootstrapSchema, mkReadModelDb } from '../../service-bridge/read-model-pg.testkit';
import { isUnstorableInputError } from './pg-input-error.filter';
import { StorableTextModule } from './storable-text.module';

/**
 * #781 (ADR 0036) on real Postgres 18 through the production driver stack (postgres.js + Kysely's PostgresJSDialect +
 * CamelCasePlugin): the three refusals the backstop maps are exactly what Postgres raises, they reach the filter as
 * the driver's own `PostgresError` (unwrapped), and a malformed uuid (also 22P02) is NOT mapped. Then, end to end on a
 * real comment insert (the real `CommentService.create` and `CommentRepo`): a NUL in the selection is refused by the
 * interceptor before the handler, and a comment `content` whose JSON string decodes to NUL — invisible to the
 * interceptor, it only becomes NUL inside the service — is refused by Postgres and answered 400 by the filter, where
 * both used to be a 500. Self-skips without AUTHZ_TEST_PG_URL; the `docmost-authz-pg` CI job provides Postgres.
 */
const d = PG_URL ? describe : describe.skip;

describe('real-PG storable-text backstop (#781)', () => {
  it('is not vacuous: runs against a real Postgres when the CI lane requires it', () => {
    if (process.env.AUTHZ_REQUIRE_PG === '1') expect(PG_URL).toBeTruthy();
  });
});

const SCHEMA = 'storable_text_backstop_pg_spec'; // never pg_*: Postgres reserves the prefix
const PAGE = { id: uuid(781), spaceId: uuid(782), workspaceId: uuid(783) };
const USER = { id: uuid(784), name: 'Commenter' };
const PostgresError = (postgres as unknown as { PostgresError: abstract new (...a: never[]) => Error }).PostgresError;

/** The `comments` columns `CommentRepo.insertComment` writes, typed as in the Docmost migrations. */
const createTables = async (pg: postgres.Sql) => {
  await pg`create table users (id uuid primary key, name varchar, avatar_url varchar)`;
  await pg`
    create table comments (
      id uuid primary key default gen_random_uuid(), content jsonb, selection varchar, type varchar,
      creator_id uuid, page_id uuid not null, parent_comment_id uuid, workspace_id uuid not null, space_id uuid not null,
      resolved_at timestamptz, resolved_by_id uuid, created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(), edited_at timestamptz, deleted_at timestamptz
    )`;
  await pg`create table probe (id uuid, doc jsonb, label varchar)`;
};

d('Postgres refusals on real Postgres (#781)', () => {
  let pg: postgres.Sql;
  let appPg: postgres.Sql;
  let db: Kysely<any>;

  beforeAll(async () => {
    await bootstrapSchema(SCHEMA);
    pg = mkReadModelPg(SCHEMA, 1);
    appPg = mkReadModelPg(SCHEMA, 4);
    db = mkReadModelDb(appPg);
    await createTables(pg);
    await pg`insert into users (id, name) values (${USER.id}, ${USER.name})`;
  });
  afterAll(async () => {
    await db?.destroy();
    await pg?.end({ timeout: 5 });
  });

  /** What a Kysely insert of `row` into `probe` throws. */
  const refusal = async (row: Record<string, unknown>): Promise<unknown> => {
    try {
      await db.insertInto('probe').values(row).execute();
    } catch (e) {
      return e;
    }
    throw new Error('expected Postgres to refuse the row');
  };

  it.each([
    ['NUL in jsonb', { doc: { text: 'a\0b' } }, '22P05', true],
    ['a lone surrogate in jsonb', { doc: { text: 'x\ud83d' } }, '22P02', true],
    ['NUL in varchar', { label: 'a\0b' }, '22021', true],
    ['a malformed uuid', { id: 'not-a-uuid' }, '22P02', false],
  ])('%s: the driver’s own PostgresError (%s), unwrapped by Kysely; mapped = %s', async (_n, row, code, mapped) => {
    const e = await refusal(row);
    expect(e).toBeInstanceOf(PostgresError);
    expect((e as { code: string }).code).toBe(code);
    expect(isUnstorableInputError(e)).toBe(mapped);
  });

  it('a lone surrogate in varchar is not refused at all (the driver writes U+FFFD): nothing to map', async () => {
    await db.insertInto('probe').values({ label: 'x\ud83d' }).execute();
    const [r] = await pg<{ label: string }[]>`select label from probe where label like 'x%'`;
    expect(r.label).toBe('x�');
  });

  describe('a comment create, end to end on a real insert', () => {
    @Controller('comments')
    class CommentProbeController {
      constructor(private readonly comments: CommentService) {}
      @HttpCode(200)
      @Post('create')
      create(@Body() dto: CreateCommentDto) {
        return this.comments.create(
          { page: PAGE as never, workspaceId: PAGE.workspaceId, user: USER as never },
          dto,
        );
      }
    }

    const boot = async (withModule: boolean) => {
      const queue = { add: jest.fn(async () => undefined) };
      const service = new CommentService(
        new CommentRepo(db as never),
        {} as never,
        { emitCommentEvent: jest.fn() } as never,
        {} as never,
        queue as never,
        queue as never,
      );
      const moduleRef = await Test.createTestingModule({
        imports: withModule ? [StorableTextModule] : [],
        controllers: [CommentProbeController],
        providers: [{ provide: CommentService, useValue: service }],
      }).compile();
      const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false });
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, stopAtFirstError: true, transform: true }));
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      return app;
    };
    const count = async () => Number((await pg<{ n: string }[]>`select count(*)::text as n from comments`)[0].n);
    const doc = (text: string) =>
      JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
    const post = (app: NestFastifyApplication, body: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/comments/create',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ pageId: PAGE.id, type: 'page', ...body }),
      });

    let app: NestFastifyApplication;
    let bare: NestFastifyApplication;
    beforeAll(async () => {
      app = await boot(true);
      bare = await boot(false);
    });
    afterAll(async () => {
      await app?.close();
      await bare?.close();
    });
    beforeEach(async () => {
      await pg`delete from comments`;
    });

    it('a clean comment is inserted (the harness is real)', async () => {
      const res = await post(app, { content: doc('fine 😀'), selection: 'fine' });
      expect(res.statusCode).toBe(200);
      expect(await count()).toBe(1);
    });

    it('control: without the module, a NUL selection and a NUL-decoding content are both 500', async () => {
      expect((await post(bare, { content: doc('ok'), selection: 'a\0b' })).statusCode).toBe(500);
      expect((await post(bare, { content: doc('a\0b') })).statusCode).toBe(500);
      expect(await count()).toBe(0);
    });

    it('a NUL in the selection: 400 invalid_characters from the interceptor (field named), nothing inserted', async () => {
      const res = await post(app, { content: doc('ok'), selection: 'a\0b' });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ code: 'invalid_characters', field: 'body.selection' });
      expect(await count()).toBe(0);
    });

    it.each([
      ['NUL (22P05)', 'a\0b'],
      ['a lone surrogate (22P02)', 'x\ud83d'],
    ])('a content whose JSON string decodes to %s: 400 invalid_characters from the filter, nothing inserted', async (_n, text) => {
      const content = doc(text); // the body string holds `\\u0000`, an escape: no NUL until the service parses it
      expect(JSON.stringify({ content })).not.toContain('\0');
      const res = await post(app, { content });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ message: expect.any(String), code: 'invalid_characters' });
      expect(await count()).toBe(0);
    });
  });
});

