import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { EnvironmentService } from './integrations/environment/environment.service';
import { AuditActorInterceptor } from './common/interceptors/audit-actor.interceptor';
import { CoreModule } from './core/core.module';
import { EnvironmentModule } from './integrations/environment/environment.module';
import { CollaborationModule } from './collaboration/collaboration.module';
import { CollabDisconnectModule } from './authz/collab/collab-disconnect.module';
import { ConditionalPageModule } from './authz/page-write/conditional-page.module';
// CCC seam (#319, #62): installs the response security headers (Referrer-Policy) on EVERY response,
// including the static SPA documents an interceptor would miss. main.ts is upstream-owned, so the hook is
// registered from a CCC module instead.
import { ResponseHeadersModule } from './authz/http-headers/response-headers.module';
import { WsModule } from './ws/ws.module';
import { DatabaseModule } from '@docmost/db/database.module';
import { StorageModule } from './integrations/storage/storage.module';
import { MailModule } from './integrations/mail/mail.module';
import { QueueModule } from './integrations/queue/queue.module';
import { StaticModule } from './integrations/static/static.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { HealthModule } from './integrations/health/health.module';
import { ExportModule } from './integrations/export/export.module';
import { ImportModule } from './integrations/import/import.module';
import { SecurityModule } from './integrations/security/security.module';
import { TelemetryModule } from './integrations/telemetry/telemetry.module';
import { RedisModule } from '@nestjs-labs/nestjs-ioredis';
import { RedisConfigService } from './integrations/redis/redis-config.service';
import { CacheModule } from '@nestjs/cache-manager';
import KeyvRedis from '@keyv/redis';
import { LoggerModule } from './common/logger/logger.module';
import { ClsModule } from 'nestjs-cls';
// CCC seam: rebind AUDIT_SERVICE to the platform-forwarding audit module (replaces NoopAuditModule).
import { PlatformAuditModule } from './authz/audit/audit.module';
import { ThrottleModule } from './integrations/throttle/throttle.module';
// CCC seam (GitHub #13, Layer C): fail-closed global guard — denies any route with no authentication decision.
import { PlatformAuthorizationGuard } from './authz/route-guard/platform-authorization.guard';
// CCC seam (GitHub #29): per-IP rate limiter for the entire unauthenticated @Public surface. Registered as a
// global guard here (the one composition point); all logic + its isolated throttler config live in authz/.
import { PublicSurfaceThrottlerGuard } from './authz/route-guard/public-surface-throttler.guard';
// CCC seam (GitHub #467): per-request central audit + per-principal rate limit for authenticated /api traffic.
// Both are global interceptors (they need the post-JwtAuthGuard req.user); logic lives in authz/request-controls/.
import { ApiAccessAuditService } from './authz/request-controls/api-access-audit.service';
import { ApiAccessAuditInterceptor } from './authz/request-controls/api-access-audit.interceptor';
import { PrincipalRateLimitInterceptor } from './authz/request-controls/principal-rate-limit.interceptor';
// CCC seam (#502): remote mode refuses the engine's native space hard delete (archive is the only removal).
import { SpaceHardDeleteInterceptor } from './authz/space-delete/space-hard-delete.interceptor';

const enterpriseModules = [];
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  if (require('./ee/ee.module')?.EeModule) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    enterpriseModules.push(require('./ee/ee.module')?.EeModule);
  }
} catch (err) {
  if (process.env.CLOUD === 'true') {
    console.warn('Failed to load enterprise modules. Exiting program.\n', err);
    process.exit(1);
  }
}

@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      middleware: { mount: true },
    }),
    LoggerModule,
    PlatformAuditModule,
    CoreModule,
    DatabaseModule,
    EnvironmentModule,
    RedisModule.forRootAsync({
      useClass: RedisConfigService,
    }),
    CacheModule.registerAsync({
      isGlobal: true,
      useFactory: async (environmentService: EnvironmentService) => {
        const redisUrl = environmentService.getRedisUrl();

        return {
          ttl: 5 * 1000,
          stores: [new KeyvRedis(redisUrl)],
        };
      },
      inject: [EnvironmentService],
    }),
    CollaborationModule,
    CollabDisconnectModule,
    ConditionalPageModule,
    ResponseHeadersModule,
    WsModule,
    QueueModule,
    StaticModule,
    HealthModule,
    ImportModule,
    ExportModule,
    StorageModule.forRootAsync({
      imports: [EnvironmentModule],
    }),
    MailModule.forRootAsync({
      imports: [EnvironmentModule],
    }),
    EventEmitterModule.forRoot(),
    SecurityModule,
    TelemetryModule,
    ThrottleModule,
    ...enterpriseModules,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // CCC seam (GitHub #29): per-IP rate limit for the whole @Public surface. Registered before the authz
    // backstop so abuse is shed before any authorization work. Inert (skipIf) on every non-@Public / non-HTTP
    // route, so authenticated, collab, and WebSocket traffic are untouched; its throttler config is isolated
    // from the shared auth/ai-chat throttlers.
    {
      provide: APP_GUARD,
      useClass: PublicSurfaceThrottlerGuard,
    },
    // CCC seam (GitHub #13, Layer C): registered as a global guard so every HTTP route is deny-by-default —
    // a route with no @Public/@PlatformPublic, no AUTH_GUARD (JwtAuthGuard/CollabServiceSecretGuard), and no
    // intentional-unguarded ledger entry is 403'd. Pass-through for decided routes (their own guard enforces).
    // The build-time route-inventory fitness test keeps the ledger complete, so this cannot deny a legit route.
    {
      provide: APP_GUARD,
      useClass: PlatformAuthorizationGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditActorInterceptor,
    },
    // CCC seam (GitHub #467): authenticated /api gets a uniform per-request central-audit row AND a
    // per-principal rate limit. These are INTERCEPTORS (not guards) because the controller-scoped
    // JwtAuthGuard runs AFTER the global guards but BEFORE interceptors, so req.user is resolved here.
    // ORDER MATTERS and is load-bearing (see UPSTREAM_MODIFICATIONS.md seam #4): AuditActorInterceptor
    // (above) stamps the CLS actor first; ApiAccessAuditInterceptor wraps the request so it records the
    // final outcome INCLUDING a 429 the rate limiter raises; PrincipalRateLimitInterceptor rejects before the
    // handler runs. SpaceHardDeleteInterceptor (#502) is innermost, so its 404 is rate-limited and lands in the
    // access row too. Do not reorder.
    ApiAccessAuditService,
    {
      provide: APP_INTERCEPTOR,
      useClass: ApiAccessAuditInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: PrincipalRateLimitInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: SpaceHardDeleteInterceptor,
    },
  ],
})
export class AppModule {}
