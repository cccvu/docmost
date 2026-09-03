import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AUTHZ_MODE, resolveAuthzMode } from './authz-mode';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * Provides the single, validated AUTHZ_MODE value app-wide (@Global). Every mode-selecting DI factory
 * (the two authorization repos, search, audit) injects this ONE token so there is a single source of
 * truth and no per-concern drift. Reading ConfigService (not process.env) keeps it consistent with the
 * rest of the app's config and testable. A bad value throws here → Nest aborts boot (defense-in-depth
 * with the boot-time env validation in integrations/environment/environment.validation.ts).
 *
 * Registered in the graph via AuthzModule (which database.module.ts already imports). Being @Global,
 * one registration makes AUTHZ_MODE injectable everywhere, including the module-local search seam.
 */
@Global()
@Module({
  providers: [
    {
      provide: AUTHZ_MODE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        resolveAuthzMode(config.get<string>('AUTHZ_MODE')),
    },
  ],
  exports: [AUTHZ_MODE],
})
export class AuthzModeModule {}
