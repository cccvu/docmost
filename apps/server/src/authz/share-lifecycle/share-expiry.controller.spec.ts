import { BadRequestException, NotFoundException, RequestMethod, ValidationPipe } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ShareExpiryController } from './share-expiry.controller';
import { SetShareExpiryDto, ShareExpiryInfoDto } from './share-expiry.dto';
import { RemoteOnlyGuard } from '../mode/remote-only.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { classifyFromContext } from '../route-guard/route-classification';
import { AuthzModule } from '../authz.module';
import { ShareLifecycleModule } from './share-lifecycle.module';
import { ShareExpiryInstaller } from './share-expiry.installer';
import { ShareExpirySweeper } from './share-expiry.sweeper';

/**
 * CCC share lifecycle test — NOT upstream Docmost code (#335).
 *
 * The request-level contract of the expiry API that needs no database (the behaviour is proven on Postgres in
 * share-lifecycle.pg.spec.ts): the strict DTO through the app's OWN ValidationPipe options (main.ts), the guard
 * order (remote-only before authentication, so native answers 404 without consulting the session), the route
 * classification the fail-closed APP_GUARD applies, and the module wiring.
 */
const SHARE = '00000000-0000-4000-8000-000000000210';

// The global pipe exactly as main.ts configures it.
const pipe = new ValidationPipe({ whitelist: true, stopAtFirstError: true, transform: true });
const body = (metatype: any, value: unknown) => pipe.transform(value, { type: 'body', metatype });

describe('SetShareExpiryDto through the app ValidationPipe', () => {
  it.each([7, 30, 90, 365, null])('accepts expiresInDays %p', async (days) => {
    const dto = await body(SetShareExpiryDto, { shareId: SHARE, expiresInDays: days });
    expect(dto).toEqual({ shareId: SHARE, expiresInDays: days });
  });

  it.each([
    ['missing', {}],
    ['undefined', { expiresInDays: undefined }],
    ['another number', { expiresInDays: 15 }],
    ['zero', { expiresInDays: 0 }],
    ['negative', { expiresInDays: -7 }],
    ['a fraction', { expiresInDays: 30.5 }],
    ['a numeric string', { expiresInDays: '30' }],
    ['"never"', { expiresInDays: 'never' }],
    ['a huge number', { expiresInDays: 1e9 }],
    ['an object', { expiresInDays: { days: 30 } }],
  ])('rejects expiresInDays %s with a 400', async (_n, extra) => {
    await expect(body(SetShareExpiryDto, { shareId: SHARE, ...extra })).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([['a key, not a uuid', 'abc123def456'], ['empty', ''], ['missing', undefined]])(
    'rejects shareId %s',
    async (_n, shareId) => {
      await expect(body(SetShareExpiryDto, { shareId, expiresInDays: 30 })).rejects.toBeInstanceOf(BadRequestException);
      await expect(body(ShareExpiryInfoDto, { shareId })).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('strips unknown properties (the pipe whitelist): an expiresAt cannot be smuggled in', async () => {
    expect(
      await body(SetShareExpiryDto, { shareId: SHARE, expiresInDays: 7, expiresAt: '2999-01-01', workspaceId: 'x' }),
    ).toEqual({ shareId: SHARE, expiresInDays: 7 });
  });
});

describe('ShareExpiryController routing and guards', () => {
  it('is `shares/expiry`: POST /info and POST /', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ShareExpiryController)).toBe('shares/expiry');
    const proto = ShareExpiryController.prototype;
    expect(Reflect.getMetadata(PATH_METADATA, proto.info)).toBe('info');
    expect(Reflect.getMetadata(PATH_METADATA, proto.set)).toBe('/');
    expect(Reflect.getMetadata(METHOD_METADATA, proto.info)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(METHOD_METADATA, proto.set)).toBe(RequestMethod.POST);
  });

  it('guards: RemoteOnlyGuard BEFORE JwtAuthGuard, class-level (native answers 404 for every caller)', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ShareExpiryController)).toEqual([RemoteOnlyGuard, JwtAuthGuard]);
    expect(() => new RemoteOnlyGuard('native').canActivate()).toThrow(NotFoundException);
    expect(new RemoteOnlyGuard('remote').canActivate()).toBe(true);
  });

  it.each(['info', 'set'] as const)('%s classifies as an authenticated route (fail-closed APP_GUARD)', (h) => {
    expect(
      classifyFromContext(ShareExpiryController.prototype[h], ShareExpiryController, new Reflector(), new Set()),
    ).toBe('authenticated');
  });

  it('is mounted through AuthzModule with its installer and sweeper', () => {
    expect(Reflect.getMetadata('imports', AuthzModule)).toContain(ShareLifecycleModule);
    expect(Reflect.getMetadata('controllers', ShareLifecycleModule)).toEqual([ShareExpiryController]);
    expect(Reflect.getMetadata('providers', ShareLifecycleModule)).toEqual(
      expect.arrayContaining([ShareExpiryInstaller, ShareExpirySweeper]),
    );
  });
});
