import { BadRequestException, type ExecutionContext } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lastValueFrom, of } from 'rxjs';
import { AuthzModule } from '../authz.module';
import {
  NATIVE_FORMAT_ROUTES,
  NativeFormatInterceptor,
  NativeFormatRefusedException,
  refusesNativeFormat,
} from './native-format.interceptor';
import { NativeFormatModule } from './native-format.module';

/**
 * #716 — remote mode refuses a non-json `format` on the native page routes (their echo converts a whole page on the
 * event loop). NOT upstream Docmost code.
 */

const ctx = (route: string, body: unknown, type = 'http'): ExecutionContext => {
  const [cls, handler] = route.split('.');
  return {
    getType: () => type,
    getClass: () => ({ name: cls }),
    getHandler: () => ({ name: handler }),
    switchToHttp: () => ({ getRequest: () => ({ body, user: { user: { id: 'u1' } } }) }),
  } as unknown as ExecutionContext;
};

const run = async (mode: 'remote' | 'native', route: string, body: unknown) => {
  const handled = jest.fn(() => of('handled'));
  const interceptor = new NativeFormatInterceptor(mode);
  (interceptor as unknown as { log: { warn: jest.Mock } }).log = { warn: jest.fn() };
  try {
    const out = await lastValueFrom(interceptor.intercept(ctx(route, body), { handle: handled }));
    return { out, handled: handled.mock.calls.length };
  } catch (err) {
    return { err, handled: handled.mock.calls.length };
  }
};

describe('refusesNativeFormat (#716)', () => {
  it.each([
    ['PageController.getPage', { pageId: 'p', format: 'markdown' }, true],
    ['PageController.getPage', { pageId: 'p', format: 'html' }, true],
    ['PageController.getPage', { pageId: 'p', format: 'json' }, false],
    ['PageController.getPage', { pageId: 'p' }, false],
    ['PageController.getPage', { pageId: 'p', format: 7 }, true], // not a string: refused (the pipe would too)
    ['PageController.update', { pageId: 'p', title: 't', format: 'markdown' }, true], // the echo converts the page anyway
    ['PageController.update', { pageId: 'p', content: {}, format: 'json' }, false],
    ['PageController.create', { spaceId: 's', content: '# x', format: 'markdown' }, true],
    ['PageController.create', { spaceId: 's', content: '<p>x</p>', format: 'html' }, true],
    ['PageController.create', { spaceId: 's', content: '', format: 'markdown' }, false], // an empty page: no echo
    ['PageController.create', { spaceId: 's', format: 'markdown' }, false],
    ['PageController.create', { spaceId: 's', content: { type: 'doc' }, format: 'json' }, false],
    ['PageController.getPageHistory', { pageId: 'p', format: 'markdown' }, false], // not governed
    ['IdempotentPageCreateController.create', { content: '# x', format: 'markdown' }, false], // no echo there
  ])('%s %j → %s', (route, body, refused) => {
    expect(refusesNativeFormat(route, body as never)).toBe(refused);
  });

  it('a body that is not an object is not a format request', () => {
    expect(refusesNativeFormat('PageController.getPage', undefined)).toBe(false);
    expect(refusesNativeFormat('PageController.getPage', ['format'] as never)).toBe(false);
  });
});

describe('NativeFormatInterceptor (#716)', () => {
  it('remote: refuses before the handler with 400 use_v1, naming /v1', async () => {
    const r = await run('remote', 'PageController.getPage', { pageId: 'p', format: 'markdown' });
    expect(r.handled).toBe(0);
    expect(r.err).toBeInstanceOf(NativeFormatRefusedException);
    expect(r.err).toBeInstanceOf(BadRequestException);
    expect((r.err as BadRequestException).getResponse()).toMatchObject({ code: 'use_v1', message: expect.stringContaining('/v1') });
  });

  it('remote: a json (or absent) format passes through to the handler', async () => {
    expect(await run('remote', 'PageController.getPage', { pageId: 'p' })).toEqual({ out: 'handled', handled: 1 });
    expect(await run('remote', 'PageController.update', { pageId: 'p', format: 'json', content: {} })).toEqual({
      out: 'handled',
      handled: 1,
    });
  });

  it('native mode keeps upstream behaviour (the echo runs)', async () => {
    expect(await run('native', 'PageController.getPage', { pageId: 'p', format: 'markdown' })).toEqual({
      out: 'handled',
      handled: 1,
    });
  });

  it('a non-http context is never touched', async () => {
    const interceptor = new NativeFormatInterceptor('remote');
    const handle = jest.fn(() => of('ws'));
    await lastValueFrom(interceptor.intercept(ctx('PageController.getPage', { format: 'markdown' }, 'ws'), { handle }));
    expect(handle).toHaveBeenCalledTimes(1);
  });
});

describe('wiring (#716)', () => {
  it('every governed key is a real PageController handler on the route it names', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'core', 'page', 'page.controller.ts'), 'utf8');
    expect(src).toMatch(/export class PageController\b/);
    const routeOf: Record<string, string> = { getPage: "'/info'", create: "'create'", update: "'update'" };
    for (const key of Object.keys(NATIVE_FORMAT_ROUTES)) {
      const [cls, handler] = key.split('.');
      expect(cls).toBe('PageController');
      expect(src).toMatch(new RegExp(`@Post\\(${routeOf[handler]}\\)\\s*async ${handler}\\(`));
    }
    // and each still echoes a non-json format (if upstream drops the echo, this refusal can go too)
    expect(src.match(/[dD]to\.format !== 'json'/g)?.length).toBe(3);
  });

  it('is registered from AuthzModule as its module’s one APP_INTERCEPTOR (no upstream file registers it)', () => {
    expect(Reflect.getMetadata('imports', AuthzModule) as unknown[]).toContain(NativeFormatModule);
    expect(Reflect.getMetadata('providers', NativeFormatModule)).toEqual([
      { provide: APP_INTERCEPTOR, useClass: NativeFormatInterceptor },
    ]);
    const app = readFileSync(join(__dirname, '..', '..', 'app.module.ts'), 'utf8');
    expect(app).not.toMatch(/NativeFormat/);
  });
});
