import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';

// As in the unit spec: the gateway's runtime require pulls the collab WebSocket stack (lib0 ESM) jest cannot parse.
jest.mock('../../collaboration/collaboration.gateway', () => ({ CollaborationGateway: class CollaborationGateway {} }));

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageHistoryRepo } from '@docmost/db/repos/page/page-history.repo';
import { PageService } from '../../core/page/services/page.service';
import { PageAccessService } from '../../core/page/page-access/page-access.service';
import { CollaborationGateway } from '../../collaboration/collaboration.gateway';
import { ConditionalPageController } from './conditional-page.controller';

/**
 * #716 T1, at the HTTP boundary: the exact body the platform sends for every markdown/html `/v1` content write (#696:
 * no digest, no key) through Fastify and the SAME global ValidationPipe as main.ts (`whitelist: true` strips any
 * undeclared field). Proves the whitelist keeps `content`/`format`/`operation`, `@AuthUser` resolves from the guard's
 * `req.user`, the route answers 200 (not Nest's default 201 for a POST; this test app has no response interceptor)
 * and the page cap answers 422 `page_too_large` on the wire.
 */
const USER = { id: 'user-1', workspaceId: 'ws-1' };
const WORKSPACE = { id: 'ws-1' };
const PAGE = { id: '11111111-1111-4111-8111-111111111111', spaceId: 'space-1', title: 'T' };

async function boot(opts: { ydocBytes?: number } = {}) {
  const calls: string[] = [];
  const parse = jest.fn(async (content: unknown, format: string) => (calls.push(`parse:${format}`), { type: 'doc', content }));
  const apply = jest.fn(async (_id: string, _payload: Record<string, unknown>) => (calls.push('apply'), { applied: true }));
  const update = jest.fn(async (_page: unknown, dto: Record<string, unknown>) => (calls.push('update'), { ...PAGE, dto }));
  const db = {
    selectFrom: () => {
      const q = {
        select: () => q,
        where: () => q,
        executeTakeFirst: async () => (calls.push('size'), { bytes: opts.ydocBytes ?? 10 }),
      };
      return q;
    },
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [ConditionalPageController],
    providers: [
      { provide: PageRepo, useValue: { findById: jest.fn(async () => PAGE) } },
      { provide: PageService, useValue: { parseProsemirrorContent: parse, update } },
      {
        provide: PageAccessService,
        useValue: { validateCanEdit: jest.fn(async () => (calls.push('canEdit'), { hasRestriction: false })) },
      },
      { provide: CollaborationGateway, useValue: { conditionalUpdatePageContent: apply } },
      { provide: PageHistoryRepo, useValue: {} },
      { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
    ],
  })
    // The real JwtAuthGuard's contract: an authenticated request carries `req.user = { user, workspace }`.
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
  return { app, calls, parse, apply, update };
}

const post = (app: NestFastifyApplication, payload: unknown) =>
  app.inject({
    method: 'POST',
    url: '/pages/conditional-update',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });

describe('POST /pages/conditional-update over HTTP (#716 T1)', () => {
  let booted: Awaited<ReturnType<typeof boot>> | undefined;
  afterEach(async () => {
    await booted?.app.close();
    booted = undefined;
  });

  it.each(['markdown', 'html'] as const)('the platform\'s digest-less, unkeyed %s append: 200, applied as sent', async (format) => {
    booted = await boot();
    const content = format === 'markdown' ? '# hi' : '<h1>hi</h1>';
    const res = await post(booted.app, { pageId: PAGE.id, content, format, operation: 'append' });
    expect(res.statusCode).toBe(200);
    expect(booted.calls).toEqual(['canEdit', 'size', `parse:${format}`, 'size', 'apply', 'update']);
    expect(booted.parse).toHaveBeenCalledWith(content, format);
    const [id, payload] = booted.apply.mock.calls[0];
    expect(id).toBe(PAGE.id);
    expect(payload).toMatchObject({ operation: 'append', user: USER });
    expect(payload.expectedContentHash).toBeUndefined();
    expect(payload.idempotencyKey).toBeUndefined();
    expect(payload).not.toHaveProperty('refuseOverCap');
    // The metadata write never carries the content fields (they were consumed by the content branch).
    const dto = booted.update.mock.calls[0][1];
    expect(dto).not.toHaveProperty('content');
    expect(dto).not.toHaveProperty('format');
    expect(dto).not.toHaveProperty('operation');
    expect(JSON.parse(res.body)).not.toHaveProperty('snapshot');
  });

  it('an undeclared field is stripped by the whitelist, not applied and not refused', async () => {
    booted = await boot();
    const res = await post(booted.app, { pageId: PAGE.id, content: '# hi', format: 'markdown', operation: 'replace', bogus: 1 });
    expect(res.statusCode).toBe(200);
    expect(booted.update.mock.calls[0][1]).not.toHaveProperty('bogus');
  });

  it('an append to a page at the size cap is 422 page_too_large on the wire, nothing parsed or applied', async () => {
    booted = await boot({ ydocBytes: 3 * 1024 * 1024 });
    const res = await post(booted.app, { pageId: PAGE.id, content: '# hi', format: 'markdown', operation: 'append' });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'page_too_large' });
    expect(booted.calls).toEqual(['canEdit', 'size']);
  });

  it('a bad operation is a 400 from the pipe, before any work', async () => {
    booted = await boot();
    const res = await post(booted.app, { pageId: PAGE.id, content: '# hi', format: 'markdown', operation: 'nope' });
    expect(res.statusCode).toBe(400);
    expect(booted.calls).toEqual([]);
  });
});
