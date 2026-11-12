import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import * as ts from 'typescript';
import * as Y from 'yjs';
import { syncFrame, awarenessFrame, statelessFrame, MSG, RemoteClient } from './collab-ingress.testkit';
import { CollabUpdateGuardExtension } from './collab-update-guard.extension';
import { CollabUpdateGuard } from './update-guard';
import { requestCompaction } from '../page-write/compaction-registry';
import { COLLAB_LOAD_TRY_LATER_REASON, COLLAB_PAGE_COMPACTING_REASON } from './collab-reasons';

/**
 * #781 wiring fitness (ADR 0036). Hocuspocus 4.7.1 handles one frame at a time per connection: it awaits the
 * `beforeHandleMessage` hooks (one promise chain), then applies the frame, and the apply itself first awaits the
 * `beforeSync` hooks (Sync frames) or the `beforeHandleAwareness` hooks (awareness frames). Frames of different
 * connections interleave, so they apply in the order the guard checked them ONLY while every frame's path from check to
 * apply has the same length and no hook on it awaits anything; the guard's shadow replica is exact only under that
 * order. So: the guard is the FIRST extension, it is the ONLY `beforeHandleMessage` in the server, it never returns a
 * promise (it returns undefined or throws synchronously), and no server source defines a `beforeSync` or
 * `beforeHandleAwareness` hook (#790: either would sit on that path). #827 adds the join and load hooks, synchronous
 * too: a load gate that awaited first could share its refusal with a co-loader.
 */
const SRC = join(__dirname, '..', '..');
const posix = (p: string) => p.split(sep).join('/');

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'node_modules') sources(p, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.testkit.ts')) out.push(p);
  }
  return out;
}
const parse = (file: string) => ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

/** True when `sf` defines a hook named `name`: a method, an object-literal property or a class property. */
function definesHook(sf: ts.SourceFile, name: string): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    const named =
      (ts.isMethodDeclaration(n) || ts.isPropertyAssignment(n) || ts.isPropertyDeclaration(n) || ts.isMethodSignature(n) || ts.isShorthandPropertyAssignment(n)) &&
      n.name.getText() === name;
    if (named) found = true;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}
/** Every server source (specs and testkits excluded) that defines a hook named `name`. */
const definersOf = (name: string): string[] =>
  [...new Set(sources(SRC).filter((file) => definesHook(parse(file), name)).map((file) => posix(relative(SRC, file))))];

describe('#781 the collab update guard is wired first, alone and synchronous', () => {
  it('the gateway constructs Hocuspocus with the guard extension FIRST in `extensions`', () => {
    const gateway = parse(join(SRC, 'collaboration/collaboration.gateway.ts'));
    const firsts: string[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isNewExpression(n) && n.expression.getText() === 'Hocuspocus') {
        const config = n.arguments?.[0];
        if (config && ts.isObjectLiteralExpression(config)) {
          for (const prop of config.properties) {
            if (ts.isPropertyAssignment(prop) && prop.name.getText() === 'extensions' && ts.isArrayLiteralExpression(prop.initializer)) {
              firsts.push(prop.initializer.elements[0]?.getText() ?? '');
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(gateway);
    expect(firsts).toEqual(['new CollabUpdateGuardExtension()']);
  });

  it('it outranks every other extension (Hocuspocus sorts by priority; RedisSync is 1000)', () => {
    expect(new CollabUpdateGuardExtension().priority).toBeGreaterThan(1000);
  });

  it('no other server source defines a beforeHandleMessage hook', () => {
    // anti-vacuity: the scan sees the guard itself
    expect(definersOf('beforeHandleMessage')).toEqual(['authz/collab-ingress/collab-update-guard.extension.ts']);
  });

  it.each(['beforeSync', 'beforeHandleAwareness'])(
    'no server source defines a %s hook (Hocuspocus 4.7.1 awaits it between the guard and the apply)',
    (hook) => {
      expect(definersOf(hook)).toEqual([]);
    },
  );

  it('the hook scan detects every way an extension can define a hook (anti-vacuity for the empty lists above)', () => {
    const shapes = [
      'class E { beforeSync() {} }',
      'class E { async beforeSync(p) {} }',
      'class E { beforeSync = () => undefined; }',
      'const e = { beforeSync() {} };',
      'const e = { beforeSync: () => undefined };',
      'const beforeSync = () => undefined; const e = { beforeSync };',
    ];
    for (const text of shapes) {
      const sf = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true);
      expect([text, definesHook(sf, 'beforeSync')]).toEqual([text, true]);
    }
    expect(definesHook(ts.createSourceFile('x.ts', 'const beforeSyncNot = 1; call(beforeSync);', ts.ScriptTarget.Latest, true), 'beforeSync')).toBe(false);
  });

  it('#827: its hooks are exactly the frame hook, the post-auth join gate and the load pair; only afterLoadDocument is async', () => {
    const sf = parse(join(__dirname, 'collab-update-guard.extension.ts'));
    const hooks = new Map<string, boolean>();
    const visit = (n: ts.Node) => {
      if (ts.isClassDeclaration(n) && n.name?.text === 'CollabUpdateGuardExtension') {
        for (const m of n.members) {
          if (!ts.isMethodDeclaration(m) && !ts.isPropertyDeclaration(m)) continue;
          if (ts.getModifiers(m)?.some((x) => x.kind === ts.SyntaxKind.PrivateKeyword)) continue;
          const isAsync = !!ts.getModifiers(m)?.some((x) => x.kind === ts.SyntaxKind.AsyncKeyword);
          hooks.set(m.name.getText(), isAsync);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    // No onAuthenticate or onConnect: this extension outranks the auth extension, so a hook there would answer a client
    // that has not authenticated (a compacting refusal would tell it the page exists and is compacting).
    expect([...hooks.keys()].sort()).toEqual(['afterLoadDocument', 'beforeHandleMessage', 'connected', 'extensionName', 'onLoadDocument', 'priority']);
    // afterLoadDocument alone: #841's load repair yields a macrotask after #827's load charge (which runs before it)
    expect([...hooks].filter(([, isAsync]) => isAsync).map(([name]) => name)).toEqual(['afterLoadDocument']);
  });

  it('#827: the post-auth join gate closes the socket 1013 and never throws; the load gate throws { reason } synchronously (no co-loader shares it); afterLoadDocument never rejects', async () => {
    const guard = new CollabUpdateGuard({ logger: { warn: () => undefined } });
    const ext = new CollabUpdateGuardExtension(guard);
    const live = new Y.Doc() as Y.Doc & { name: string };
    live.name = 'page.p';
    // an authenticated join to a resident document that drains: its socket is closed, nothing is thrown
    requestCompaction(live, { reason: 'structs', userId: null, drain: true });
    const socket = { readyState: 1, close: jest.fn() };
    const joined = (document: Y.Doc) => ({ connection: { document, webSocket: socket }, documentName: 'page.p', context: {} });
    expect(ext.connected(joined(live) as never)).toBeUndefined();
    expect(socket.close).toHaveBeenCalledWith(1013, COLLAB_PAGE_COMPACTING_REASON);
    socket.close.mockClear();
    expect(ext.connected(joined(new Y.Doc()) as never)).toBeUndefined(); // a page not closed: untouched
    expect(socket.close).not.toHaveBeenCalled();
    socket.close.mockImplementation(() => {
      throw new Error('gone');
    });
    expect(ext.connected(joined(live) as never)).toBeUndefined(); // a socket that throws on close: still nothing thrown
    // a socket's load while its user is in debt; the same load from a DirectConnection is admitted
    guard.chargeLoad('u', 1e9, guard.wallClock());
    const load = (headers: Headers) => ({ document: new Y.Doc(), context: { user: { id: 'u' } }, requestHeaders: headers });
    let thrown: unknown;
    try {
      ext.onLoadDocument(load(new Headers({ 'sec-websocket-key': 'k' })) as never);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toEqual({ reason: COLLAB_LOAD_TRY_LATER_REASON });
    const direct = load(new Headers());
    expect(ext.onLoadDocument(direct as never)).toBeUndefined();
    await expect(ext.afterLoadDocument(direct as never)).resolves.toBeUndefined();
    await expect(ext.afterLoadDocument({ document: undefined } as never)).resolves.toBeUndefined();
  });

  it('its frame hook returns undefined (never a promise) for every kind of frame', () => {

    const ext = new CollabUpdateGuardExtension(new CollabUpdateGuard({ logger: { warn: () => undefined } }));
    const live = new Y.Doc() as Y.Doc & { name: string };
    live.name = 'page.p';
    const connection = { readOnly: false, webSocket: { close: () => undefined }, context: { user: { id: 'u' } } };
    const ok = new RemoteClient(live).edit(live, (f) => f.insert(0, [new Y.XmlElement('paragraph')]));
    const frames = [syncFrame(ok), awarenessFrame([{ clientID: 7, state: {} }]), syncFrame(ok, 0)];
    for (const update of frames) {
      const ret = ext.beforeHandleMessage({ connection, document: live, update, context: connection.context } as never);
      expect(ret).toBeUndefined();
    }
    // A refusal is a synchronous throw of exactly { code, reason } (Hocuspocus logs the thrown object as is).
    let thrown: unknown;
    try {
      ext.beforeHandleMessage({ connection: { ...connection }, document: live, update: statelessFrame('x', MSG.BroadcastStateless), context: connection.context } as never);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toEqual({ code: 4422, reason: 'ccc:collab-update-refused:stateless' });
  });
});
