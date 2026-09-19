import {
  Injectable,
  Module,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { validateCookiePosture } from './validate-cookie-posture';

/**
 * CCC session-cookie boot module — NOT upstream Docmost code (wiki-v2 issue #310).
 *
 * Runs the session-cookie posture check (validate-cookie-posture.ts) at application bootstrap, BEFORE the
 * server binds its port, so a misconfigured posture fails fast instead of serving a shadowable cookie.
 * `onApplicationBootstrap` throwing rejects `app.listen()`, and Docmost's main.ts does not catch it, so the
 * process exits non-zero without ever accepting a request (fail-closed). EnvironmentModule is `@Global`, so
 * EnvironmentService injects here with no extra import. Registered via app.module.ts (seam #4).
 */
@Injectable()
export class SessionCookiePostureValidator implements OnApplicationBootstrap {
  constructor(private readonly environmentService: EnvironmentService) {}

  onApplicationBootstrap(): void {
    validateCookiePosture(this.environmentService);
  }
}

@Module({
  providers: [SessionCookiePostureValidator],
})
export class SessionCookieModule {}
