import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuthzModule } from '../authz.module';
import { OriginCheckModule } from './origin-check.module';
import { ForkOriginCheckGuard } from './origin-check.guard';

/**
 * wiki-v2 #655: the origin check is registered, and only where intended. The HTTP guard comes from AuthzModule
 * (in the graph via database.module, so no upstream file registers it); the socket.io middleware comes from the one
 * line in the gateway's afterInit (seam #161), which ws-origin-check.spec.ts drives for real.
 */
describe('origin-check wiring (#655)', () => {
  it('OriginCheckModule is imported by AuthzModule and provides exactly the APP_GUARD', () => {
    expect(Reflect.getMetadata('imports', AuthzModule) as unknown[]).toContain(OriginCheckModule);
    expect(Reflect.getMetadata('providers', OriginCheckModule)).toEqual([
      { provide: 'APP_GUARD', useClass: ForkOriginCheckGuard },
    ]);
  });

  it('no upstream module registers it a second time', () => {
    const app = readFileSync(join(__dirname, '..', '..', 'app.module.ts'), 'utf8');
    expect(app).not.toMatch(/OriginCheck/);
  });

  it('the gateway installs the socket middleware first in afterInit', () => {
    const gw = readFileSync(join(__dirname, '..', '..', 'ws', 'ws.gateway.ts'), 'utf8');
    expect(gw).toMatch(/import \{ socketOriginCheck \} from '\.\.\/authz\/origin-check\/ws-origin-check';/);
    expect(gw).toMatch(/afterInit\(server: Server\): void \{\s*server\.use\(socketOriginCheck\(this\.environmentService\)\);/);
  });
});
