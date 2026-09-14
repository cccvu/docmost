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
 *   - tolerate `undefined` from `handleYjsEvent` (RedisSync disabled) as "not flushed" rather than
 *     failing the caller — the platform's settle is best-effort;
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
    expect(flushPageContent).toHaveBeenCalledWith(PAGE);
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
  // "not flushed", NOT a 500 — the platform treats the settle as best-effort and falls through.
  it('treats an undefined gateway result (RedisSync disabled) as not flushed', async () => {
    const { controller } = build(undefined);
    await expect(
      controller.flushPageContent({ pageId: PAGE }),
    ).resolves.toEqual({
      flushed: false,
    });
  });

  // The outcome is normalized to a strict boolean so a malformed handler result can never be
  // mistaken for a successful settle by the caller.
  it('normalizes any non-true flushed value to false', async () => {
    for (const result of [{}, { flushed: 'yes' }, { flushed: 1 }, null]) {
      const { controller } = build(result);
      await expect(
        controller.flushPageContent({ pageId: PAGE }),
      ).resolves.toEqual({ flushed: false });
    }
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
