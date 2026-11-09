import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import * as ts from 'typescript';
import * as Y from 'yjs';
import { syncFrame, awarenessFrame, statelessFrame, MSG, RemoteClient } from './collab-ingress.testkit';
import { CollabUpdateGuardExtension } from './collab-update-guard.extension';
import { CollabUpdateGuard } from './update-guard';

/**
 * #781 wiring fitness (ADR 0036). Hocuspocus 3.4.4 runs `beforeHandleMessage` hooks as one promise chain per frame and
 * applies the frame when the chain resolves. Frames therefore apply in the order they arrived ONLY while every frame's
 * chain has the same length and no hook awaits anything; the guard's shadow replica is exact only under that order.
 * So: the guard is the FIRST extension, it is the ONLY `beforeHandleMessage` in the server, and it never returns a
 * promise (it returns undefined or throws synchronously).
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
    const definers: string[] = [];
    for (const file of sources(SRC)) {
      const sf = parse(file);
      const visit = (n: ts.Node) => {
        const named = (ts.isMethodDeclaration(n) || ts.isPropertyAssignment(n) || ts.isPropertyDeclaration(n) || ts.isMethodSignature(n)) && n.name.getText() === 'beforeHandleMessage';
        if (named) definers.push(posix(relative(SRC, file)));
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(definers.length).toBeGreaterThan(0); // anti-vacuity: the scan saw the guard
    expect([...new Set(definers)]).toEqual(['authz/collab-ingress/collab-update-guard.extension.ts']);
  });

  it('its hook is not async, and returns undefined (never a promise) for every kind of frame', () => {
    const sf = parse(join(__dirname, 'collab-update-guard.extension.ts'));
    let asyncHook = true;
    const visit = (n: ts.Node) => {
      if (ts.isMethodDeclaration(n) && n.name.getText() === 'beforeHandleMessage') {
        asyncHook = !!ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(asyncHook).toBe(false);

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
