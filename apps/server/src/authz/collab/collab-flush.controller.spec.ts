import { ServiceUnavailableException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

// The controller only uses CollaborationGateway as a constructor TYPE, but NestJS emits its runtime
// require for DI metadata — which transitively pulls in the collab WebSocket stack (lib0 ESM) that
// jest cannot parse. Stub the module so the heavy graph never loads; every test injects its own fake.
jest.mock('../../collaboration/collaboration.gateway', () => ({
  CollaborationGateway: class {},
}));

import {
  CollabFlushController,
  FlushPageContentDto,
} from './collab-flush.controller';
import { SKIP_TRANSFORM_KEY } from '../../common/decorators/skip-transform.decorator';

/**
 * CCC authorization integration test (part of the fork's compatibility suite).
 *
 * The inbound content-settle seam (issue 282). Intended behavior, from the controller doc-comment:
 *   - route the settle to the doc-owning node through the gateway, keyed by pageId;
 *   - report a boolean outcome, never leaking the gateway's shape;
 *   - keep "there was nothing to settle" and "we could not settle" DISTINGUISHABLE: the first is a
 *     successful 200 `{flushed:false}`, the second a 503. Both would otherwise be `{flushed:false}`, and
 *     the caller reads that as "no live document to race with" — which would let a guarded write proceed
 *     unconditionally against a stale row, i.e. the #282 lost update this seam exists to prevent;
 *   - emit a BARE body (no upstream `{data,success,status}` envelope), per incident #181.
 */
describe('CollabFlushController.flushPageContent', () => {
  const PAGE = '22222222-2222-4222-8222-222222222222';

  const build = (result: unknown) => {
    const flushPageContent = jest.fn(async () => result);
    const controller = new CollabFlushController({
      flushPageContent,
    } as never);
    return { controller, flushPageContent };
  };

  it('routes the settle to the doc-owning node via the gateway, keyed by pageId', async () => {
    const { controller, flushPageContent } = build({ flushed: true });
    await expect(
      controller.flushPageContent({ pageId: PAGE }),
    ).resolves.toEqual({
      flushed: true,
    });
    expect(flushPageContent).toHaveBeenCalledTimes(1);
    expect(flushPageContent).toHaveBeenCalledWith(PAGE, { withDigest: false });
  });

  it('reports flushed:false when the document was not resident (nothing to settle)', async () => {
    const { controller } = build({ flushed: false });
    await expect(
      controller.flushPageContent({ pageId: PAGE }),
    ).resolves.toEqual({
      flushed: false,
    });
  });

  // RedisSync disabled ⇒ gateway.handleYjsEvent resolves to undefined. That must degrade to
  // RedisSync disabled makes handleYjsEvent resolve to undefined. That is "we don't know whether a live
  // document holds unsaved edits", NOT "there is none" — and with Redis off, content writes are dropped
  // silently anyway, so answering "nothing to settle" would be the worst possible guess. Fail loudly.
  it('503s on an undefined gateway result (RedisSync disabled) rather than reporting nothing to settle', async () => {
    const { controller } = build(undefined);
    await expect(
      controller.flushPageContent({ pageId: PAGE }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  // The distinction this whole endpoint turns on.
  it('503s when the flush ERRORED, but 200s when there was simply nothing resident', async () => {
    const errored = build({ flushed: false, reason: 'error' });
    await expect(
      errored.controller.flushPageContent({ pageId: PAGE }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    const quiet = build({ flushed: false });
    await expect(
      quiet.controller.flushPageContent({ pageId: PAGE }),
    ).resolves.toEqual({ flushed: false });
  });

  // The digest costs a full serialize + hash of the document on the shared collab event loop, so the
  // caller decides. A read settle asks for `withDigest: false`; only a guarded write needs the version.
  it('passes the caller\u2019s withDigest choice through to the collab node', async () => {
    const { controller, flushPageContent } = build({ flushed: true });
    await controller.flushPageContent({ pageId: PAGE, withDigest: true });
    expect(flushPageContent).toHaveBeenLastCalledWith(PAGE, {
      withDigest: true,
    });
    await controller.flushPageContent({ pageId: PAGE });
    expect(flushPageContent).toHaveBeenLastCalledWith(PAGE, {
      withDigest: false,
    });
  });

  // The outcome is normalized to a strict boolean so a malformed handler result can never be
  // mistaken for a successful settle by the caller.
  it('normalizes any non-true flushed value to false', async () => {
    for (const result of [{}, { flushed: 'yes' }, { flushed: 1 }]) {
      const { controller } = build(result);
      await expect(
        controller.flushPageContent({ pageId: PAGE }),
      ).resolves.toEqual({ flushed: false });
    }
    // `null` is not a shape we can read an outcome from — same "we don't know" as undefined.
    await expect(
      build(null).controller.flushPageContent({ pageId: PAGE }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('validates pageId as a UUID', async () => {
    const bad = plainToInstance(FlushPageContentDto, { pageId: 'not-a-uuid' });
    expect(await validate(bad)).not.toHaveLength(0);
    const good = plainToInstance(FlushPageContentDto, { pageId: PAGE });
    expect(await validate(good)).toHaveLength(0);
  });

  // Incident #181: a service-facing route must emit the bare documented body, not the upstream
  // `{ data, success, status }` envelope the global interceptor would otherwise add.
  it('is annotated @SkipTransform() so the wire body is bare', () => {
    expect(
      Reflect.getMetadata(
        SKIP_TRANSFORM_KEY,
        CollabFlushController.prototype.flushPageContent,
      ),
    ).toBe(true);
  });
});
