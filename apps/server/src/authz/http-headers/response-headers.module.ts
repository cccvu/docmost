import { Module, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { RESPONSE_SECURITY_HEADERS } from './response-headers';

/**
 * CCC response-header seam — NOT upstream Docmost code (issue #319, #62).
 *
 * Installs `RESPONSE_SECURITY_HEADERS` on every response this process emits, via a Fastify `onSend` hook.
 *
 * WHY A HOOK AND NOT AN INTERCEPTOR/MIDDLEWARE: the responses that matter most here are the SPA documents,
 * which `@fastify/static` serves outside Nest's interceptor pipeline. An `onSend` hook is the one place that
 * sees every response, static assets included.
 *
 * WHY A MODULE AND NOT `main.ts`: `main.ts` is an upstream-owned file this fork must not edit (AGENTS.md),
 * which is also why the platform emits HSTS from its own paths rather than here. Taking the adapter from
 * `HttpAdapterHost` inside `onModuleInit` gets the same Fastify instance with the composition seam we already
 * own — `app.module.ts` — as the only upstream file touched.
 *
 * TIMING: `onModuleInit` runs during `app.init()`, before the adapter's `ready()`/`listen()`, which is the
 * window Fastify allows hooks to be added in. Headers are set only when absent, so a route that deliberately
 * sets its own (the attachment CSP, the frame header) still wins.
 */
@Module({})
export class ResponseHeadersModule implements OnModuleInit {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  onModuleInit(): void {
    const instance = this.adapterHost?.httpAdapter?.getInstance?.();
    // Fail SOFT, not closed: these headers are defense in depth, and a non-Fastify adapter (or a test harness
    // that never built one) must not take the whole app down at boot for them.
    if (!instance || typeof instance.addHook !== 'function') return;

    instance.addHook(
      'onSend',
      (_req: unknown, reply: any, payload: unknown, done: any) => {
        for (const [name, value] of RESPONSE_SECURITY_HEADERS) {
          if (!reply.getHeader(name)) reply.header(name, value);
        }
        done(null, payload);
      },
    );
  }
}
