import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

// The controller takes CollaborationGateway as a constructor TYPE; stub the module so the collab stack never loads.
jest.mock('../../collaboration/collaboration.gateway', () => ({
  CollaborationGateway: class {},
}));

import { SKIP_TRANSFORM_KEY } from '../../common/decorators/skip-transform.decorator';
import { RemoteOnlyGuard } from '../mode/remote-only.guard';
import { CollabServiceSecretGuard } from './service-secret.guard';
import { CollabQuiesceController } from './collab-quiesce.controller';

/**
 * wiki-v2 #919: the east-west quiesce routes the platform's maintenance route relays to. The contract (fixed across
 * the tracks): `POST /api/collab/quiesce` → 200 `{ draining: true, resident, failed }`; `POST /api/collab/quiesce/abort`
 * → 200 `{ draining: false }`; service-secret auth and remote mode only, like flush-page-content; bare bodies.
 */
describe('CollabQuiesceController', () => {
  const build = (result = { resident: 0, failed: [] as string[] }) => {
    const gateway = { quiesce: jest.fn(async () => result), endQuiesce: jest.fn() };
    return { controller: new CollabQuiesceController(gateway as never), gateway };
  };

  it('quiesce runs the gateway drain and answers the contract shape', async () => {
    const t = build({ resident: 2, failed: ['page.a'] });
    await expect(t.controller.quiesce()).resolves.toEqual({ draining: true, resident: 2, failed: ['page.a'] });
    expect(t.gateway.quiesce).toHaveBeenCalledTimes(1);
    expect(t.gateway.endQuiesce).not.toHaveBeenCalled();
  });

  it('abort lifts the drain and answers { draining: false }', () => {
    const t = build();
    expect(t.controller.abort()).toEqual({ draining: false });
    expect(t.gateway.endQuiesce).toHaveBeenCalledTimes(1);
    expect(t.gateway.quiesce).not.toHaveBeenCalled();
  });

  it('is gated like flush-page-content: RemoteOnlyGuard then the service secret, on the class', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, CollabQuiesceController)).toEqual([RemoteOnlyGuard, CollabServiceSecretGuard]);
    expect(Reflect.getMetadata(PATH_METADATA, CollabQuiesceController)).toBe('collab');
  });

  it.each([
    ['quiesce', 'quiesce'],
    ['abort', 'quiesce/abort'],
  ] as const)('%s is POST /api/collab/%s, 200, with a bare body', (handler, path) => {
    const fn = CollabQuiesceController.prototype[handler];
    expect(Reflect.getMetadata(METHOD_METADATA, fn)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(PATH_METADATA, fn)).toBe(path);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, fn)).toBe(200);
    expect(Reflect.getMetadata(SKIP_TRANSFORM_KEY, fn)).toBe(true);
  });
});
