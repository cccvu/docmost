import {
  ForbiddenException,
  NotFoundException,
  PreconditionFailedException,
  ServiceUnavailableException,
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
 * Compare-and-swap page write (#282, ADR 0017) — the request-level contract.
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
  const PAGE = { id: 'page-uuid-1', spaceId: 'space-1' };
  const USER = { id: 'user-1' } as never;
  const DIGEST = 'a'.repeat(64);

  const build = (opts: {
    page?: unknown;
    canEdit?: 'ok' | 'deny';
    apply?: unknown;
    updateThrows?: boolean;
  }) => {
    const calls: string[] = [];
    const pageRepo = {
      findById: jest.fn(
        async () => (calls.push('findById'), 'page' in opts ? opts.page : PAGE),
      ),
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
    );
    return {
      controller,
      calls,
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

  it('never treats a malformed outcome as applied', async () => {
    for (const apply of [{}, { applied: 'yes' }, { applied: 1 }, null]) {
      const { controller } = build({ apply });
      await expect(
        controller.conditionalUpdate(dto(), USER),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    }
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
  it('forwards inherited metadata fields and strips only content/operation/format/digest', async () => {
    const { controller, pageService } = build({});
    await controller.conditionalUpdate(
      dto({ title: 'T2', icon: '\u2b50', parentPageId: 'parent-1' }),
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
    for (const stripped of [
      'content',
      'operation',
      'format',
      'expectedContentHash',
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
  });
});
