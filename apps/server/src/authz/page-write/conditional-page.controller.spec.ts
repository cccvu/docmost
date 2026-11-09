import {
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  PreconditionFailedException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

// The controller uses CollaborationGateway as a constructor TYPE, but NestJS emits its runtime require for
// DI metadata — which pulls in the collab WebSocket stack (lib0 ESM) jest cannot parse. Stub the module.
jest.mock('../../collaboration/collaboration.gateway', () => ({
  CollaborationGateway: class {},
}));

import {
  ConditionalPageController,
  ConditionalUpdatePageDto,
} from './conditional-page.controller';

/**
 * Compare-and-swap page write (#282, ADR 0019) — the request-level contract.
 *
 * What these pin, in order of importance:
 *   1. the fork still re-enforces authorization itself (the "suspenders" half of the platform/fork
 *      defense-in-depth) — routing content around `PageController.update` must not lose it;
 *   2. a refused precondition changes NOTHING — not the content, not the metadata;
 *   3. failing to establish the precondition is an ERROR, never a silent unconditional write;
 *   4. metadata goes through PageService.update with content omitted, so the ordinary path's side effects
 *      (row bump, lastUpdatedById, contributorIds, watcher enqueue) are preserved and the content branch
 *      cannot run twice.
 */
describe('ConditionalPageController.conditionalUpdate', () => {
  // `id` deliberately DIFFERS from the `pageId` callers send (see the slug test below): a fixture where
  // they are equal cannot tell `dto.pageId` and `page.id` apart, and that blindness hid a real defect.
  const PAGE = { id: 'page-uuid-1', spaceId: 'space-1', title: 'Current title' };
  const USER = { id: 'user-1' } as never;
  const DIGEST = 'a'.repeat(64);

  const build = (opts: {
    page?: unknown;
    canEdit?: 'ok' | 'deny';
    apply?: unknown;
    updateThrows?: boolean;
    /** #485: the row content at snapshot time and the newest history version's content. */
    current?: unknown;
    lastHistory?: { id: string; title?: string | null; content: unknown } | null;
    /** #716: the page's stored ydoc size (`octet_length`), or the error its query throws. Default: tiny. */
    ydocBytes?: number | Error | (() => number);
  }) => {
    const calls: string[] = [];
    // #716: a Kysely-shaped fake for the page-size query; records its SQL so a spec can pin what it reads.
    const sizeQueries: string[] = [];
    const db = {
      selectFrom: (table: string) => {
        const q = {
          select: (sel: { toOperationNode?: () => unknown }) => {
            sizeQueries.push(`${table}:${JSON.stringify(sel?.toOperationNode?.() ?? sel)}`);
            return q;
          },
          where: () => q,
          executeTakeFirst: async () => {
            calls.push('size');
            if (opts.ydocBytes instanceof Error) throw opts.ydocBytes;
            if (typeof opts.ydocBytes === 'function') return { bytes: opts.ydocBytes() };
            return { bytes: opts.ydocBytes ?? 100 };
          },
        };
        return q;
      },
    };
    const pageRepo = {
      findById: jest.fn(async (_id: string, o?: { includeContent?: boolean }) => {
        calls.push('findById');
        if (o?.includeContent && 'current' in opts) return { ...PAGE, content: opts.current, contributorIds: ['u9'] };
        return 'page' in opts ? opts.page : PAGE;
      }),
    };
    const pageHistoryRepo = {
      findPageLastHistory: jest.fn(async () => (calls.push('lastHistory'), opts.lastHistory ?? null)),
      insertPageHistory: jest.fn(async () => (calls.push('saveHistory'), { id: 'hist-new' })),
    };
    const pageAccessService = {
      validateCanEdit: jest.fn(async () => {
        calls.push('validateCanEdit');
        if (opts.canEdit === 'deny') throw new ForbiddenException();
        return { hasRestriction: false };
      }),
    };
    const pageService = {
      parseProsemirrorContent: jest.fn(async (content: unknown) => {
        calls.push('parse');
        return content;
      }),
      update: jest.fn(async (_page: unknown, _dto: unknown, _user: unknown) => {
        calls.push('update');
        if (opts.updateThrows) throw new Error('metadata write failed');
        return { id: 'page-uuid-1', title: 'T', content: { type: 'doc' } };
      }),
    };
    const gateway = {
      conditionalUpdatePageContent: jest.fn(async () => {
        calls.push('conditionalApply');
        // `in` rather than `??`: `undefined`/`null` are the outcomes under test, not "unset".
        return 'apply' in opts ? opts.apply : { applied: true };
      }),
    };
    const controller = new ConditionalPageController(
      pageRepo as never,
      pageService as never,
      pageAccessService as never,
      gateway as never,
      pageHistoryRepo as never,
      db as never,
    );
    return {
      controller,
      calls,
      sizeQueries,
      pageHistoryRepo,
      pageRepo,
      pageAccessService,
      pageService,
      gateway,
    };
  };

  const dto = (
    over: Partial<ConditionalUpdatePageDto> = {},
  ): ConditionalUpdatePageDto =>
    ({
      pageId: 'page-1',
      expectedContentHash: DIGEST,
      content: '<p>hi</p>',
      format: 'html',
      operation: 'replace',
      ...over,
    }) as ConditionalUpdatePageDto;

  it('404s an unknown page before doing anything else', async () => {
    const { controller, calls } = build({ page: null });
    await expect(
      controller.conditionalUpdate(dto(), USER),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(calls).toEqual(['findById']);
  });

  // (1) The suspenders. This route bypasses PageController.update, so it must re-run the same check —
  // otherwise a platform-side authorization bug would have no second line of defense on content writes.
  it('re-enforces edit access itself, and refuses BEFORE touching content or metadata', async () => {
    const { controller, calls, pageAccessService } = build({ canEdit: 'deny' });
    await expect(
      controller.conditionalUpdate(dto(), USER),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(pageAccessService.validateCanEdit).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['findById', 'validateCanEdit']);
  });

  it('applies content conditionally with the caller’s digest, then the metadata', async () => {
    const { controller, calls, gateway, pageService } = build({});
    await controller.conditionalUpdate(dto({ title: 'New title' }), USER);

    expect(calls).toEqual([
      'findById',
      'validateCanEdit',
      'parse',
      'conditionalApply',
      'update',
    ]);
    expect(gateway.conditionalUpdatePageContent).toHaveBeenCalledWith(
      'page-uuid-1',
      expect.objectContaining({
        expectedContentHash: DIGEST,
        operation: 'replace',
        user: USER,
      }),
    );
    // (4) content is omitted from the metadata update, so PageService's own content branch cannot re-run.
    const metadataDto = pageService.update.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(metadataDto).not.toHaveProperty('content');
    expect(metadataDto.title).toBe('New title');
  });

  // The compare-and-swap is keyed on the DOCUMENT NAME, and live documents are named `page.<uuid>`.
  // `PageRepo.findById` also resolves a non-UUID as a slugId, so forwarding the caller's raw `pageId`
  // would name a document that does not exist: the precondition would find nothing to compare and apply
  // UNCONDITIONALLY while still reporting success, and the direct connection would fork a second
  // RedisSync-owned Y.Doc over the same row whose store races the real one. Both failures are silent,
  // and both are the lost update this route exists to prevent — reachable through the route itself.
  it('hands the collab layer the RESOLVED page id, never the slug the caller sent', async () => {
    const { controller, gateway, pageService } = build({});
    await controller.conditionalUpdate(
      dto({ pageId: 'my-page-slug-abc123', title: 'New title' }),
      USER,
    );
    expect(gateway.conditionalUpdatePageContent).toHaveBeenCalledWith(
      'page-uuid-1',
      expect.anything(),
    );
    expect(gateway.conditionalUpdatePageContent).not.toHaveBeenCalledWith(
      'my-page-slug-abc123',
      expect.anything(),
    );
    expect(
      (pageService.update.mock.calls[0][1] as { pageId: string }).pageId,
    ).toBe('page-uuid-1');
  });

  // (2) A refused precondition must leave the page exactly as it was — including its metadata, so the
  // caller can retry the whole request cleanly after re-reading.
  it('412s on a stale digest and writes NOTHING — not even the metadata', async () => {
    const { controller, calls, pageService } = build({
      apply: { applied: false, reason: 'precondition' },
    });
    await expect(
      controller.conditionalUpdate(dto({ title: 'New title' }), USER),
    ).rejects.toBeInstanceOf(PreconditionFailedException);
    expect(pageService.update).not.toHaveBeenCalled();
    expect(calls).not.toContain('update');
  });

  // (3) The fail-closed rule. If we cannot establish the precondition we must NOT fall back to an
  // unconditional write: a caller cannot tell a guarded 200 from an unguarded one, so silently
  // downgrading the guarantee is invisible — and this endpoint exists precisely to make it hold.
  it('503s when the collab node could not establish the precondition', async () => {
    const { controller, pageService } = build({
      apply: { applied: false, reason: 'error' },
    });
    await expect(
      controller.conditionalUpdate(dto(), USER),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(pageService.update).not.toHaveBeenCalled();
  });

  // RedisSync disabled makes handleYjsEvent resolve to undefined. That is "we don't know", not "applied".
  it('503s when the gateway returns undefined (RedisSync disabled)', async () => {
    const { controller } = build({ apply: undefined });
    await expect(
      controller.conditionalUpdate(dto(), USER),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('#716: an unrecognized reason (a newer collab node) is 500 write_outcome_unknown, never a retryable 503', async () => {
    for (const reason of ['applied_partially', 'some_future_reason']) {
      const { controller, pageService } = build({ apply: { applied: false, reason } });
      const err = await controller.conditionalUpdate(dto(), USER).catch((e) => e);
      expect(err).toBeInstanceOf(InternalServerErrorException);
      expect((err as HttpException).getResponse()).toMatchObject({ code: 'write_outcome_unknown' });
      expect(pageService.update).not.toHaveBeenCalled();
    }
    for (const reason of ['error', 'unknown']) {
      const { controller } = build({ apply: { applied: false, reason } });
      await expect(controller.conditionalUpdate(dto(), USER)).rejects.toBeInstanceOf(ServiceUnavailableException);
    }
  });

  it('never treats a malformed outcome as applied', async () => {
    for (const apply of [{}, { applied: 'yes' }, { applied: 1 }, null]) {
      const { controller } = build({ apply });
      await expect(
        controller.conditionalUpdate(dto(), USER),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    }
  });

  // #429: a keyed write already applied within the idempotency window is a SUCCESSFUL retry (`duplicate`),
  // NOT a 412/503. A CONTENT-ONLY duplicate returns the CURRENT page as a 2xx no-op and re-applies NOTHING
  // — not the content (the fork deduped it), and there is no metadata — so it is genuinely inert (no row
  // bump, no reattribution, no broadcast). This is the bounded-idempotency guarantee: a non-idempotent
  // append/prepend is not double-applied on a timeout retry.
  it('returns the current page as an inert no-op on a duplicate CONTENT-ONLY keyed write', async () => {
    const { controller, calls, gateway, pageService } = build({
      apply: { applied: false, reason: 'duplicate' },
    });
    // `dto()` carries content but NO metadata field.
    const out = await controller.conditionalUpdate(dto({ idempotencyKey: 'K1' }), USER);
    // The key was forwarded to the collab layer…
    expect(gateway.conditionalUpdatePageContent).toHaveBeenCalledWith(
      'page-uuid-1',
      expect.objectContaining({ idempotencyKey: 'K1' }),
    );
    // …content was NOT re-applied and there is no metadata, so PageService.update never runs (inert)…
    expect(pageService.update).not.toHaveBeenCalled();
    expect(calls).not.toContain('update');
    // …and the response is the current page (re-read) + permissions, same shape as the success path.
    expect(out).toEqual({
      ...PAGE,
      permissions: { canEdit: true, hasRestriction: false },
    });
    // findById ran twice: the initial lookup + the no-op re-read.
    expect(calls.filter((c) => c === 'findById')).toHaveLength(2);
  });

  // #429 architecture review (F1): a duplicate content write that ALSO carried metadata must still (re)apply
  // the metadata. The content dedup only guards the non-idempotent append/prepend; the metadata is applied
  // by a SEPARATE PageService.update, and if that step failed on the first attempt (content committed + key
  // recorded, metadata not), a blanket no-op here would SILENTLY DROP the title/icon/parent change on every
  // retry. Metadata is idempotent, so re-applying it on the duplicate branch is safe and correct.
  it('re-applies metadata on a duplicate keyed write that carried metadata (no silent drop, F1)', async () => {
    const { controller, calls, gateway, pageService } = build({
      apply: { applied: false, reason: 'duplicate' },
    });
    const out = await controller.conditionalUpdate(
      dto({ title: 'New title', idempotencyKey: 'K1' }),
      USER,
    );
    // The content was deduped (a single conditionalApply, never re-applied to a fresh doc)…
    expect(gateway.conditionalUpdatePageContent).toHaveBeenCalledTimes(1);
    // …but the metadata WAS (re)written, with content stripped so the content branch cannot run.
    expect(pageService.update).toHaveBeenCalledTimes(1);
    const metadataDto = pageService.update.mock.calls[0][1] as Record<string, unknown>;
    expect(metadataDto).not.toHaveProperty('content');
    expect(metadataDto.title).toBe('New title');
    // Response is PageService.update's page + permissions, exactly like the applied path.
    expect(out).toEqual({
      id: 'page-uuid-1',
      title: 'T',
      content: { type: 'doc' },
      permissions: { canEdit: true, hasRestriction: false },
    });
    expect(calls).toEqual([
      'findById',
      'validateCanEdit',
      'parse',
      'conditionalApply',
      'update',
    ]);
  });

  // The fork half of the falsy-content agreement. Upstream `PageService.update` gates its content branch
  // on TRUTHINESS (`updatePageDto.content && …`), so `content: ""` is "no content supplied" there. If this
  // route treated it as supplied, `htmlToJson('')` would produce a valid EMPTY document and the same
  // request would WIPE the page here while no-opping on the ordinary route — an outcome decided by
  // whether a colleague happens to have the page open. The platform mirrors this predicate; both halves
  // need their own test, or reverting either one silently reintroduces the divergence.
  it.each([
    ['empty string', ''],
    ['null', null],
  ])(
    'treats a falsy content (%s) as metadata-only, like the ordinary route',
    async (_label, content) => {
      const { controller, calls, gateway, pageService } = build({});
      await controller.conditionalUpdate(
        dto({
          content: content as never,
          format: 'html',
          operation: 'replace',
        }),
        USER,
      );
      expect(gateway.conditionalUpdatePageContent).not.toHaveBeenCalled();
      expect(calls).toEqual(['findById', 'validateCanEdit', 'update']);
      // …and the falsy content is not smuggled through to PageService either.
      expect(pageService.update.mock.calls[0][1]).not.toHaveProperty('content');
    },
  );

  // A metadata-only conditional write skips the collab round-trip entirely — there is no content to guard.
  it('skips the conditional apply when the request carries no content', async () => {
    const { controller, calls, gateway } = build({});
    await controller.conditionalUpdate(
      {
        pageId: 'page-1',
        expectedContentHash: DIGEST,
        title: 'Renamed',
      } as ConditionalUpdatePageDto,
      USER,
    );
    expect(gateway.conditionalUpdatePageContent).not.toHaveBeenCalled();
    expect(calls).toEqual(['findById', 'validateCanEdit', 'update']);
  });

  // The partial-write window: content is committed and the metadata step then fails. The request MUST
  // surface the failure — reporting success here would hide a half-applied write from the caller.
  it('propagates a metadata failure after the content was applied (no false success)', async () => {
    const { controller, gateway } = build({ updateThrows: true });
    await expect(
      controller.conditionalUpdate(dto({ title: 'x' }), USER),
    ).rejects.toThrow('metadata write failed');
    expect(gateway.conditionalUpdatePageContent).toHaveBeenCalledTimes(1);
  });

  it('returns the canonical page plus its permissions, like the ordinary update route', async () => {
    const { controller } = build({});
    await expect(controller.conditionalUpdate(dto(), USER)).resolves.toEqual({
      id: 'page-uuid-1',
      title: 'T',
      content: { type: 'doc' },
      permissions: { canEdit: true, hasRestriction: false },
    });
  });

  // The metadata projection forwards by subtraction, so a field added to the upstream UpdatePageDto keeps
  // flowing through this route instead of being silently stripped on it alone (whitelist: true, no
  // forbidNonWhitelisted) — which would make the same PATCH behave differently depending on whether
  // someone has the page open.
  it('forwards inherited metadata fields and strips content/operation/format/digest/idempotencyKey', async () => {
    const { controller, pageService } = build({});
    await controller.conditionalUpdate(
      dto({
        title: 'T2',
        icon: '\u2b50',
        parentPageId: 'parent-1',
        idempotencyKey: 'K9',
      }),
      USER,
    );
    const metadataDto = pageService.update.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(metadataDto).toEqual({
      pageId: 'page-uuid-1',
      title: 'T2',
      icon: '\u2b50',
      parentPageId: 'parent-1',
    });
    // idempotencyKey is a transport concern, not a page column \u2014 it must NOT leak into PageService.update
    // (correctness review), alongside the content/CAS fields.
    for (const stripped of [
      'content',
      'operation',
      'format',
      'expectedContentHash',
      'idempotencyKey',
    ]) {
      expect(metadataDto).not.toHaveProperty(stripped);
    }
  });

  it('accepts a digest-less request, and validates operation/format when content is present', async () => {
    // expectedContentHash is OPTIONAL: the settle omits it when no document was resident, and its absence
    // means there was nothing live to race with, so the write applies unconditionally.
    expect(
      await validate(
        plainToInstance(ConditionalUpdatePageDto, { pageId: 'p' }),
      ),
    ).toHaveLength(0);
    expect(
      await validate(
        plainToInstance(ConditionalUpdatePageDto, {
          pageId: 'p',
          expectedContentHash: DIGEST,
          content: 'x',
          operation: 'nope',
          format: 'html',
        }),
      ),
    ).not.toHaveLength(0);
    expect(
      await validate(
        plainToInstance(ConditionalUpdatePageDto, {
          pageId: 'p',
          expectedContentHash: DIGEST,
        }),
      ),
    ).toHaveLength(0);
    // #429: idempotencyKey is an OPTIONAL string; a present string validates, a non-string does not.
    expect(
      await validate(
        plainToInstance(ConditionalUpdatePageDto, {
          pageId: 'p',
          idempotencyKey: 'op-abc-123',
        }),
      ),
    ).toHaveLength(0);
    expect(
      await validate(
        plainToInstance(ConditionalUpdatePageDto, {
          pageId: 'p',
          idempotencyKey: 123 as never,
        }),
      ),
    ).not.toHaveLength(0);
    // #429 security review (S2): the key is bounded (@MaxLength 255) so an over-long value cannot bloat the
    // on-doc ledger. 255 chars validate; 256 do not.
    expect(
      await validate(
        plainToInstance(ConditionalUpdatePageDto, {
          pageId: 'p',
          idempotencyKey: 'x'.repeat(255),
        }),
      ),
    ).toHaveLength(0);
    expect(
      await validate(
        plainToInstance(ConditionalUpdatePageDto, {
          pageId: 'p',
          idempotencyKey: 'x'.repeat(256),
        }),
      ),
    ).not.toHaveLength(0);
  });

  // #485: reversible version restore — the current content is saved BEFORE a replace, once.
  describe('snapshotBefore (#485)', () => {
    const OLD = { type: 'doc', content: [{ type: 'paragraph' }] };
    const NEW = { type: 'doc', content: [] };

    it('saves the current content as a version AFTER the edit check and parse, BEFORE the apply', async () => {
      const t = build({ current: OLD, lastHistory: null });
      const out = (await t.controller.conditionalUpdate(
        dto({ content: NEW as never, format: 'json', snapshotBefore: true }),
        USER,
      )) as { snapshot?: unknown };
      expect(out.snapshot).toEqual({ status: 'saved', historyId: 'hist-new' });
      expect(t.calls.indexOf('validateCanEdit')).toBeLessThan(t.calls.indexOf('saveHistory'));
      expect(t.calls.indexOf('parse')).toBeLessThan(t.calls.indexOf('saveHistory'));
      expect(t.calls.indexOf('saveHistory')).toBeLessThan(t.calls.indexOf('conditionalApply'));
      expect(t.pageHistoryRepo.insertPageHistory).toHaveBeenCalledWith(
        expect.objectContaining({ pageId: PAGE.id, content: OLD, contributorIds: ['u9'] }),
      );
    });

    it('reports unchanged (no new version) when the current content already equals the newest version', async () => {
      const t = build({
        current: OLD,
        lastHistory: { id: 'hist-7', title: PAGE.title, content: { content: [{ type: 'paragraph' }], type: 'doc' } },
      });
      const out = (await t.controller.conditionalUpdate(
        dto({ content: NEW as never, format: 'json', snapshotBefore: true }),
        USER,
      )) as { snapshot?: unknown };
      expect(out.snapshot).toEqual({ status: 'unchanged', historyId: 'hist-7' });
      expect(t.pageHistoryRepo.insertPageHistory).not.toHaveBeenCalled();
    });

    it('reports unchanged when the incoming content equals the current content', async () => {
      const t = build({ current: NEW, lastHistory: null });
      const out = (await t.controller.conditionalUpdate(
        dto({ content: NEW as never, format: 'json', snapshotBefore: true }),
        USER,
      )) as { snapshot?: unknown };
      expect(out.snapshot).toEqual({ status: 'unchanged', historyId: null });
      expect(t.pageHistoryRepo.insertPageHistory).not.toHaveBeenCalled();
    });

    it('#781: a legacy row and version nested 100k deep snapshot without a RangeError (the hash is depth-bounded)', async () => {
      const deep = () => ({ type: 'doc', content: [{ type: 'paragraph', attrs: { textAlign: JSON.parse('{"a":'.repeat(100_000) + '1' + '}'.repeat(100_000)) } }] });
      const t = build({ current: deep(), lastHistory: { id: 'hist-7', title: PAGE.title, content: deep() } });
      const out = (await t.controller.conditionalUpdate(
        dto({ content: NEW as never, format: 'json', snapshotBefore: true }),
        USER,
      )) as { snapshot?: unknown };
      expect(out.snapshot).toEqual({ status: 'unchanged', historyId: 'hist-7' });
    });

    it('saves a version when the newest one has the same content but a different title', async () => {
      const t = build({ current: OLD, lastHistory: { id: 'hist-7', title: 'an older title', content: OLD } });
      const out = (await t.controller.conditionalUpdate(
        dto({ content: NEW as never, format: 'json', snapshotBefore: true }),
        USER,
      )) as { snapshot?: unknown };
      expect(out.snapshot).toEqual({ status: 'saved', historyId: 'hist-new' });
    });

    it('saves a version when only the TITLE would change (a version restore of equal content is still undoable)', async () => {
      const t = build({ current: NEW, lastHistory: null });
      const out = (await t.controller.conditionalUpdate(
        dto({ title: 'the restored title', content: NEW as never, format: 'json', snapshotBefore: true }),
        USER,
      )) as { snapshot?: unknown };
      expect(out.snapshot).toEqual({ status: 'saved', historyId: 'hist-new' });
      expect(t.pageHistoryRepo.insertPageHistory).toHaveBeenCalledWith(expect.objectContaining({ title: PAGE.title }));
    });

    it('reports unchanged when the incoming title AND content equal the current ones', async () => {
      const t = build({ current: NEW, lastHistory: null });
      const out = (await t.controller.conditionalUpdate(
        dto({ title: PAGE.title as never, content: NEW as never, format: 'json', snapshotBefore: true }),
        USER,
      )) as { snapshot?: unknown };
      expect(out.snapshot).toEqual({ status: 'unchanged', historyId: null });
    });

    it('saves nothing when the edit check refuses', async () => {
      const t = build({ current: OLD, canEdit: 'deny' });
      await expect(
        t.controller.conditionalUpdate(dto({ content: NEW as never, format: 'json', snapshotBefore: true }), USER),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(t.pageHistoryRepo.insertPageHistory).not.toHaveBeenCalled();
    });

    it('does not snapshot an append, or when the flag is absent (response carries no snapshot)', async () => {
      const t = build({ current: OLD });
      await t.controller.conditionalUpdate(dto({ operation: 'append', snapshotBefore: true }), USER);
      const plain = (await t.controller.conditionalUpdate(dto(), USER)) as { snapshot?: unknown };
      expect(t.pageHistoryRepo.insertPageHistory).not.toHaveBeenCalled();
      expect(plain.snapshot).toBeUndefined();
    });

    it('never forwards snapshotBefore into PageService.update (not a page column)', async () => {
      const t = build({ current: OLD });
      await t.controller.conditionalUpdate(dto({ content: NEW as never, format: 'json', snapshotBefore: true }), USER);
      expect(t.pageService.update.mock.calls[0][1]).not.toHaveProperty('snapshotBefore');
    });

    it('validates snapshotBefore as a boolean', async () => {
      const bad = plainToInstance(ConditionalUpdatePageDto, { pageId: 'p', snapshotBefore: 'yes' });
      expect((await validate(bad)).map((e) => e.property)).toContain('snapshotBefore');
    });
  });

  /**
   * #716 T1: the platform sends EVERY markdown/html `/v1` content write here with neither a digest nor a key (#696).
   * That request must stay the native write minus the echo: edit check, (size check for an append), parse, apply,
   * metadata update — no compare, no dedup, no snapshot, no markdown/HTML echo.
   */
  it.each(['markdown', 'html'] as const)(
    'T1: the unkeyed, digest-less %s append is the native write minus the echo',
    async (format) => {
      const t = build({});
      const content = format === 'markdown' ? '# hi' : '<h1>hi</h1>';
      const res = await t.controller.conditionalUpdate(
        dto({ expectedContentHash: undefined, format, content, operation: 'append' }),
        USER,
      );
      // #716: the entry size check, the parse, then the re-check under the page's growth lock, then the apply.
      expect(t.calls).toEqual(['findById', 'validateCanEdit', 'size', 'parse', 'size', 'conditionalApply', 'update']);
      expect(t.pageService.parseProsemirrorContent).toHaveBeenCalledWith(content, format);
      expect(t.gateway.conditionalUpdatePageContent).toHaveBeenCalledWith('page-uuid-1', {
        prosemirrorJson: content,
        operation: 'append',
        user: USER,
        expectedContentHash: undefined,
        idempotencyKey: undefined,
      });
      const metadata = t.pageService.update.mock.calls[0][1] as Record<string, unknown>;
      expect(metadata).not.toHaveProperty('content');
      expect(metadata).not.toHaveProperty('format');
      expect(metadata).not.toHaveProperty('operation');
      expect(res).not.toHaveProperty('snapshot');
      expect(JSON.stringify(res)).not.toContain(content); // no markdown/HTML echo
    },
  );

  describe('#716 the API page-size cap (append/prepend only)', () => {
    const OVER = 3 * 1024 * 1024; // = the default cap: at the cap is over

    it('an unkeyed append to a page at the cap → 422 page_too_large, before the parse; nothing applied', async () => {
      const t = build({ ydocBytes: OVER });
      const err = await t.controller.conditionalUpdate(dto({ operation: 'append' }), USER).catch((e) => e);
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      expect((err as HttpException).getResponse()).toMatchObject({ code: 'page_too_large' });
      expect(t.calls).toEqual(['findById', 'validateCanEdit', 'size']);
      expect(t.pageHistoryRepo.insertPageHistory).not.toHaveBeenCalled();
    });

    it('prepend is capped the same way; just under the cap is applied', async () => {
      await expect(
        build({ ydocBytes: OVER }).controller.conditionalUpdate(dto({ operation: 'prepend' }), USER),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      const t = build({ ydocBytes: OVER - 1 });
      await t.controller.conditionalUpdate(dto({ operation: 'append' }), USER);
      expect(t.gateway.conditionalUpdatePageContent).toHaveBeenCalledWith(
        'page-uuid-1',
        expect.not.objectContaining({ refuseOverCap: true }),
      );
    });

    it('a replace on a page over the cap is applied, and issues no size query (the escape hatch)', async () => {
      const t = build({ ydocBytes: 50 * 1024 * 1024 });
      await t.controller.conditionalUpdate(dto({ operation: 'replace' }), USER);
      expect(t.calls).not.toContain('size');
      expect(t.calls).toContain('conditionalApply');
    });

    it('a caller who may not edit gets 403, never 422 (and no size query): authorization comes first', async () => {
      const t = build({ ydocBytes: OVER, canEdit: 'deny' });
      await expect(t.controller.conditionalUpdate(dto({ operation: 'append' }), USER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(t.calls).toEqual(['findById', 'validateCanEdit']);
    });

    it('a size-query DB error refuses (503, nothing parsed or applied) — never reads as 0', async () => {
      const t = build({ ydocBytes: new Error('connection reset') });
      const err = await t.controller.conditionalUpdate(dto({ operation: 'append' }), USER).catch((e) => e);
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(t.calls).toEqual(['findById', 'validateCanEdit', 'size']);
    });

    it('reads octet_length(ydoc) only — never the page bytes themselves', async () => {
      const t = build({});
      await t.controller.conditionalUpdate(dto({ operation: 'append' }), USER);
      expect(t.sizeQueries).toHaveLength(2); // the entry check and the re-check under the growth lock
      for (const q of t.sizeQueries) {
        expect(q).toMatch(/^pages:/);
        expect(q).toContain('octet_length(ydoc)');
      }
    });

    it('keyed: the handler decides AFTER its dedup and CAS — a duplicate (an applied retry) replays 200', async () => {
      const t = build({ ydocBytes: OVER, apply: { applied: false, reason: 'duplicate' } });
      const res = await t.controller.conditionalUpdate(dto({ operation: 'append', idempotencyKey: 'K' }), USER);
      expect(t.gateway.conditionalUpdatePageContent).toHaveBeenCalledWith(
        'page-uuid-1',
        expect.objectContaining({ refuseOverCap: true, idempotencyKey: 'K' }),
      );
      expect(res).toMatchObject({ id: 'page-uuid-1' });
    });

    it('keyed and over the cap: the content is NOT parsed (no worker time) and the handler gets no content', async () => {
      const t = build({ ydocBytes: OVER, apply: { applied: false, reason: 'too_large' } });
      await t.controller.conditionalUpdate(dto({ operation: 'append', idempotencyKey: 'K' }), USER).catch(() => undefined);
      expect(t.pageService.parseProsemirrorContent).not.toHaveBeenCalled();
      expect(t.calls).toEqual(['findById', 'validateCanEdit', 'size', 'conditionalApply']);
      expect(t.gateway.conditionalUpdatePageContent).toHaveBeenCalledWith(
        'page-uuid-1',
        expect.objectContaining({ prosemirrorJson: undefined, refuseOverCap: true }),
      );
    });

    it('concurrent appends that both passed the entry check are decided one after another (overshoot stays one write)', async () => {
      // `bytes` is what the row holds: the first append's store moves it past the cap before it releases the lock.
      let bytes = OVER - 1;
      let releaseFirst!: () => void;
      const firstHeld = new Promise<void>((r) => (releaseFirst = r));
      const t = build({ ydocBytes: () => bytes });
      let applies = 0;
      t.gateway.conditionalUpdatePageContent.mockImplementation(async () => {
        applies++;
        t.calls.push('conditionalApply');
        if (applies === 1) {
          await firstHeld;
          bytes = OVER; // the first append's store
        }
        return { applied: true };
      });
      const first = t.controller.conditionalUpdate(dto({ operation: 'append', expectedContentHash: undefined }), USER);
      const second = t.controller.conditionalUpdate(dto({ operation: 'append', expectedContentHash: undefined }), USER);
      // Let both run up to where they block: the first inside its apply, the second on the page's growth lock.
      for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
      expect(applies).toBe(1);
      expect(t.calls.filter((c) => c === 'parse')).toHaveLength(2); // the second passed the entry check and parsed
      releaseFirst();
      await expect(first).resolves.toMatchObject({ id: 'page-uuid-1' });
      const err = await second.catch((e) => e);
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      expect((err as HttpException).getResponse()).toMatchObject({ code: 'page_too_large' });
      expect(applies).toBe(1);
      const { growthLockCount } = await import('./page-size');
      expect(growthLockCount()).toBe(0);
    });

    it('keyed: a fresh append to a page at the cap → too_large → 422, no metadata written', async () => {
      const t = build({ ydocBytes: OVER, apply: { applied: false, reason: 'too_large' } });
      const err = await t.controller
        .conditionalUpdate(dto({ operation: 'append', idempotencyKey: 'K', title: 'T2' }), USER)
        .catch((e) => e);
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      expect((err as HttpException).getResponse()).toMatchObject({ code: 'page_too_large' });
      expect(t.pageService.update).not.toHaveBeenCalled();
    });

    it('the refusal message derives the configured size and names the way out', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PageTooLargeException } = require('./page-size');
      const msg = (new PageTooLargeException(5 * 1024 * 1024).getResponse() as { message: string }).message;
      expect(msg).toContain('5 MiB');
      expect(msg).toMatch(/new page and link to it|replace this page/);
    });
  });

  describe('#716 O2/R4 an applied-but-unconfirmed write', () => {
    it('answers 500 write_outcome_unknown — NOT a retryable 503 — and writes no metadata', async () => {
      const t = build({ apply: { applied: false, reason: 'applied_unconfirmed' } });
      const err = await t.controller
        .conditionalUpdate(dto({ operation: 'append', expectedContentHash: undefined, title: 'T2' }), USER)
        .catch((e) => e);
      expect(err).toBeInstanceOf(InternalServerErrorException);
      expect(err).not.toBeInstanceOf(ServiceUnavailableException);
      expect((err as HttpException).getStatus()).toBe(500);
      expect((err as HttpException).getResponse()).toEqual({
        message: expect.any(String),
        code: 'write_outcome_unknown',
      });
      expect(t.pageService.update).not.toHaveBeenCalled();
    });
  });
});
