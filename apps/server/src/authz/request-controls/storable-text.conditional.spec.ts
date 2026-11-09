import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import * as postgres from 'postgres';

// As in conditional-page-http.spec.ts: the gateway's runtime require pulls the collab WebSocket stack (lib0 ESM).
jest.mock('../../collaboration/collaboration.gateway', () => ({ CollaborationGateway: class CollaborationGateway {} }));

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageHistoryRepo } from '@docmost/db/repos/page/page-history.repo';
import { PageService } from '../../core/page/services/page.service';
import { PageAccessService } from '../../core/page/page-access/page-access.service';
import { CollaborationGateway } from '../../collaboration/collaboration.gateway';
import { ConditionalPageController } from '../page-write/conditional-page.controller';
import { StorableTextModule } from './storable-text.module';

/**
 * #781 (ADR 0036, false-positive review finding 5): `POST /api/pages/conditional-update` applies the CONTENT to the live
 * document first and writes the metadata (title, …) after it, through `PageService.update`. A NUL in the title failed
 * only at that second write (22021), after the content had committed — a 500 the platform rendered "may have been
 * applied", and the pg backstop alone would have made it a 400 that says "nothing applied". So NUL and lone surrogates
 * are refused BEFORE the handler: nothing is parsed, applied or written.
 *
 * The control arm runs the same request without the module, with `PageService.update` failing the way Postgres does,
 * and proves the content WAS applied before the failure.
 */
const USER = { id: 'user-1', workspaceId: 'ws-1' };
const WORKSPACE = { id: 'ws-1' };
const PAGE = { id: '11111111-1111-4111-8111-111111111111', spaceId: 'space-1', title: 'T' };
const CONTENT = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }] };

/** The error Postgres raises for a NUL in a varchar title. */
const pgNul = () =>
  new (postgres as unknown as { PostgresError: new (x: object) => Error }).PostgresError({
    code: '22021',
    message: 'invalid byte sequence for encoding "UTF8": 0x00',
    severity: 'ERROR',
  });

async function boot(withModule: boolean) {
  const calls: string[] = [];
  const db = {
    selectFrom: () => {
      const q = { select: () => q, where: () => q, executeTakeFirst: async () => (calls.push('size'), { bytes: 10 }) };
      return q;
    },
  };
  const moduleRef = await Test.createTestingModule({
    imports: withModule ? [StorableTextModule] : [],
    controllers: [ConditionalPageController],
    providers: [
      { provide: PageRepo, useValue: { findById: jest.fn(async () => (calls.push('find'), PAGE)) } },
      {
        provide: PageService,
        useValue: {
          parseProsemirrorContent: jest.fn(async (c: unknown) => (calls.push('parse'), c)),
          update: jest.fn(async (_p: unknown, dto: { title?: string }) => {
            calls.push('update');
            if (dto.title?.includes('\0')) throw pgNul();
            return { ...PAGE, ...dto };
          }),
        },
      },
      {
        provide: PageAccessService,
        useValue: { validateCanEdit: jest.fn(async () => (calls.push('canEdit'), { hasRestriction: false })) },
      },
      {
        provide: CollaborationGateway,
        useValue: { conditionalUpdatePageContent: jest.fn(async () => (calls.push('apply'), { applied: true })) },
      },
      { provide: PageHistoryRepo, useValue: {} },
      { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue({
      canActivate: (ctx: any) => {
        ctx.switchToHttp().getRequest().user = { user: USER, workspace: WORKSPACE };
        return true;
      },
    })
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, stopAtFirstError: true, transform: true }));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, calls };
}

const post = (app: NestFastifyApplication, payload: unknown) =>
  app.inject({
    method: 'POST',
    url: '/pages/conditional-update',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });

describe('conditional update: content then title (#781)', () => {
  let booted: Awaited<ReturnType<typeof boot>> | undefined;
  afterEach(async () => {
    await booted?.app.close();
    booted = undefined;
  });

  it('control: without the guard, the content is APPLIED and only then does the title write fail (500)', async () => {
    booted = await boot(false);
    const res = await post(booted.app, { pageId: PAGE.id, content: CONTENT, format: 'json', operation: 'replace', title: 'bad\0title' });
    expect(res.statusCode).toBe(500);
    expect(booted.calls).toEqual(['find', 'canEdit', 'parse', 'apply', 'update']);
  });

  it.each([
    ['a NUL in the title', { title: 'bad\0title' }],
    ['a lone surrogate in the title', { title: 'bad\ud83d' }],
    ['a NUL inside the content', { content: { ...CONTENT, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a\0' }] }] } }],
  ])('%s: 400 invalid_characters before anything is read, parsed or applied', async (_n, patch) => {
    booted = await boot(true);
    const res = await post(booted.app, { pageId: PAGE.id, content: CONTENT, format: 'json', operation: 'replace', ...patch });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'invalid_characters' });
    expect(booted.calls).toEqual([]);
  });

  it('a clean content + title write is unchanged: 200, content applied then title', async () => {
    booted = await boot(true);
    const res = await post(booted.app, { pageId: PAGE.id, content: CONTENT, format: 'json', operation: 'replace', title: 'Fine 😀' });
    expect(res.statusCode).toBe(200);
    expect(booted.calls).toEqual(['find', 'canEdit', 'parse', 'apply', 'update']);
  });
});
