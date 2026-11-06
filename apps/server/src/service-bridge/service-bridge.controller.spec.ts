import { ServiceBridgeController } from './service-bridge.controller';

// setDocmostAuthCookie is exercised elsewhere (session-cookie specs); stub it so this spec isolates the
// ONE thing it exists to pin — that the controller forwards dto.clientIp into the service (#330).
jest.mock('../authz/session-cookie/docmost-auth-cookie', () => ({
  setDocmostAuthCookie: jest.fn(),
}));

/**
 * #330 regression guard for the controller→service wiring. The DTO, the service, and the OpenAPI contract
 * are each tested in isolation, but nothing else exercises `POST /api/service/session`'s handler — so
 * reverting `mintSession(dto.externalId, dto.clientIp)` back to `mintSession(dto.externalId)` would drop the
 * client IP, silently re-record NULL, and leave the whole suite green. This asserts the forwarding directly.
 */
describe('ServiceBridgeController.mintSession — clientIp wiring (#330)', () => {
  const makeController = () => {
    const service = { mintSession: jest.fn(async () => 'authtoken-xyz') } as any;
    // environmentService + workspaces are unused by mintSession (cookie set is stubbed); pass minimal stubs.
    const controller = new ServiceBridgeController(service, {} as any, {} as any);
    return { controller, service };
  };
  const res = {} as any; // setDocmostAuthCookie is mocked → res is never touched here

  it('forwards dto.clientIp to service.mintSession (dropping it would silently record NULL)', async () => {
    const { controller, service } = makeController();
    await controller.mintSession({ externalId: 'ext-1', clientIp: '203.0.113.7' } as any, res);
    expect(service.mintSession).toHaveBeenCalledWith('ext-1', '203.0.113.7', undefined);
  });

  it('forwards undefined when clientIp is absent (old-platform build)', async () => {
    const { controller, service } = makeController();
    await controller.mintSession({ externalId: 'ext-1' } as any, res);
    expect(service.mintSession).toHaveBeenCalledWith('ext-1', undefined, undefined);
  });
});

/**
 * #713: the step-up freshness reaches the service only after the window check, and a violation mints nothing. Dropping
 * the forwarding would mint every session stale (every gated route would loop through step-up); dropping the check
 * would let the platform grant any window.
 */
describe('ServiceBridgeController.mintSession — step-up freshness (#713)', () => {
  const makeController = () => {
    const service = { mintSession: jest.fn(async () => 'authtoken-xyz') } as any;
    return { controller: new ServiceBridgeController(service, {} as any, {} as any), service };
  };
  const res = {} as any;
  const now = () => Math.floor(Date.now() / 1000);

  it('forwards a valid authTime/freshUntil pair', async () => {
    const { controller, service } = makeController();
    const authTime = now() - 5;
    await controller.mintSession({ externalId: 'ext-1', authTime, freshUntil: authTime + 7200 } as any, res);
    expect(service.mintSession).toHaveBeenCalledWith('ext-1', undefined, { authTime, freshUntil: authTime + 7200 });
  });

  it.each<[string, Record<string, number>]>([
    ['a future authTime', { authTime: now() + 3600, freshUntil: now() + 7200 }],
    ['freshUntil not after authTime', { authTime: now(), freshUntil: now() }],
    ['a window over 24h', { authTime: now(), freshUntil: now() + 86401 }],
    ['half a pair', { authTime: now() }],
  ])('400s on %s and mints nothing', async (_label, body) => {
    const { controller, service } = makeController();
    await expect(controller.mintSession({ externalId: 'ext-1', ...body } as any, res)).rejects.toMatchObject({
      status: 400,
    });
    expect(service.mintSession).not.toHaveBeenCalled();
  });
});
