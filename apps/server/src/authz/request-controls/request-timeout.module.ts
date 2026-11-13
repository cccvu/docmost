import { Module, OnModuleInit, Optional } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { applyRequestTimeout, bufferedBodyDeadlineHook } from './request-timeout';

/**
 * CCC request-receipt bounds — NOT upstream Docmost code (issue #763).
 *
 * In `onModuleInit` it sets the http server's `requestTimeout` to `DOCMOST_REQUEST_TIMEOUT_MS` (Fastify built it
 * with 0, i.e. no bound on receiving a body) and installs the `bufferedBodyDeadlineHook` `onRequest` hook (the
 * tighter deadline for bodies Fastify buffers). Rationale and arithmetic: `request-timeout.ts`.
 *
 * WHY HERE AND NOT `main.ts`: `main.ts` is upstream-owned and this fork must not edit it (AGENTS.md); the
 * constructor option there would be the natural place. The server object exists as soon as the `FastifyAdapter`
 * is constructed and Node re-reads `requestTimeout` on every connection check, so setting it from
 * `onModuleInit` (during `app.init()`, before `listen()`, the window Fastify allows hooks to be added in) is
 * equivalent. Mounted from `AuthzModule` (CCC-owned), so no upstream file changes; it therefore also runs in
 * `collab-main`, where it is equally correct (upgrades are not counted).
 *
 * Fail SOFT, like `ResponseHeadersModule`: with no http adapter (a test harness that compiles modules without
 * an app) or a non-Fastify one, it does nothing rather than fail the boot. A bad VALUE still throws
 * (`applyRequestTimeout`), because that is a code defect, not an environment.
 */
@Module({})
export class RequestTimeoutModule implements OnModuleInit {
  constructor(@Optional() private readonly adapterHost?: HttpAdapterHost) {}

  onModuleInit(): void {
    const adapter = this.adapterHost?.httpAdapter;
    if (!adapter) return;

    const server = adapter.getHttpServer?.();
    if (server && typeof server.headersTimeout === 'number') applyRequestTimeout(server);

    const instance = adapter.getInstance?.();
    if (instance && typeof instance.addHook === 'function') {
      instance.addHook('onRequest', bufferedBodyDeadlineHook());
    }
  }
}
