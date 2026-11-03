import { readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';
import { sourceFiles } from '../route-guard/ast-sink-scan';
import { scanRoutes } from '../route-guard/static-route-scan';
import { REMOTE_REFUSAL_FAMILIES, REMOTE_REFUSED_ROUTES } from './remote-refusal.table';

/**
 * Remote refusal table FITNESS TEST (#636) — NOT upstream Docmost code.
 *
 * `RemoteNativeRefusalInterceptor` matches by `Controller.handler` key and writes `entry.route` into the audit row, so
 * the table is only as good as those strings. This pins them statically against the source (no boot):
 *  - every key names a real route, and the route is a `@Post` whose scanned path equals `entry.route` (so neither a
 *    rename nor a path change upstream can leave a key that silently stops matching, or a row naming the wrong path);
 *  - the families are disjoint (`buildRefusalIndex` throws too, but at import, where it reads as a crash);
 *  - app.module.ts registers the interceptor EXACTLY once as an APP_INTERCEPTOR, after the per-principal rate limiter,
 *    read from the TS AST of the `@Module` providers array (a commented-out or stray copy never counts), and nothing
 *    else in the tree references the class (so it is not also registered in a module the collab app loads).
 * Each family's key set is pinned both ways against its sink in the family specs beside this one.
 */
const SRC_ROOT = join(__dirname, '..', '..'); // .../apps/server/src
const INTERCEPTOR = 'RemoteNativeRefusalInterceptor';

/** The `useClass` names of every `{ provide: APP_INTERCEPTOR, useClass: X }` in a `@Module({ providers: [...] })`, in order. */
export function appInterceptors(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isClassDeclaration(stmt)) continue;
    for (const dec of ts.getDecorators(stmt) ?? []) {
      const call = dec.expression;
      if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== 'Module') continue;
      const [meta] = call.arguments;
      if (!meta || !ts.isObjectLiteralExpression(meta)) continue;
      for (const prop of meta.properties) {
        if (!ts.isPropertyAssignment(prop) || prop.name.getText(sf) !== 'providers') continue;
        if (!ts.isArrayLiteralExpression(prop.initializer)) continue;
        for (const el of prop.initializer.elements) {
          if (!ts.isObjectLiteralExpression(el)) continue;
          const field = (name: string) =>
            el.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(sf) === name)
              ?.initializer;
          const provide = field('provide');
          const useClass = field('useClass');
          if (provide && ts.isIdentifier(provide) && provide.text === 'APP_INTERCEPTOR' && useClass && ts.isIdentifier(useClass)) {
            out.push(useClass.text);
          }
        }
      }
    }
  }
  return out;
}

/** Files (relative to SRC_ROOT) whose code — not comments or strings — names `identifier`. */
function filesReferencing(identifier: string): string[] {
  const hits: string[] = [];
  for (const full of sourceFiles(SRC_ROOT)) {
    const src = readFileSync(full, 'utf8');
    if (!src.includes(identifier)) continue;
    const sf = ts.createSourceFile(full, src, ts.ScriptTarget.Latest, true);
    let found = false;
    const visit = (n: ts.Node): void => {
      if (found) return;
      if (ts.isIdentifier(n) && n.text === identifier) found = true;
      else ts.forEachChild(n, visit);
    };
    visit(sf);
    if (found) hits.push(full.slice(SRC_ROOT.length + 1).split('\\').join('/'));
  }
  return hits.sort();
}

describe('the remote refusal table names real routes, once each (#636)', () => {
  const routes = scanRoutes(SRC_ROOT);
  const byKey = new Map(routes.map((r) => [`${r.controller}.${r.handler}`, r]));

  it('scans a meaningful tree (guards against a silently-empty scan)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(80);
    expect(REMOTE_REFUSED_ROUTES.size).toBeGreaterThanOrEqual(20);
  });

  it.each([...REMOTE_REFUSED_ROUTES].map(([key, hit]) => [key, hit.entry.route]))(
    '%s is a real @Post route at %s',
    (key, route) => {
      const r = byKey.get(key);
      expect(r).toBeDefined();
      expect(r!.handlerText).toMatch(/@Post\s*\(/);
      expect(`POST ${r!.httpPath}`).toBe(route);
    },
  );

  it('the families are disjoint', () => {
    const all = REMOTE_REFUSAL_FAMILIES.flatMap((f) => [...f.routes.keys()]);
    expect(new Set(all).size).toBe(all.length);
  });

  it('no refused route is @Public (the interceptor attributes every row to an authenticated actor)', () => {
    expect([...REMOTE_REFUSED_ROUTES.keys()].filter((k) => byKey.get(k)?.isPublic)).toEqual([]);
  });

  it('app.module.ts registers the interceptor exactly once, after the per-principal rate limiter', () => {
    const order = appInterceptors('app.module.ts', readFileSync(join(SRC_ROOT, 'app.module.ts'), 'utf8'));
    expect(order.filter((c) => c === INTERCEPTOR)).toHaveLength(1);
    expect(order).toContain('PrincipalRateLimitInterceptor');
    expect(order.indexOf(INTERCEPTOR)).toBeGreaterThan(order.indexOf('PrincipalRateLimitInterceptor'));
    // The #467 access audit wraps it too, so each refused attempt lands in the access row.
    expect(order.indexOf(INTERCEPTOR)).toBeGreaterThan(order.indexOf('ApiAccessAuditInterceptor'));
    // The two interceptors it replaced are gone.
    expect(order).not.toContain('SpaceHardDeleteInterceptor');
    expect(order).not.toContain('SpaceNativeCreateInterceptor');
  });

  it('only app.module.ts and the interceptor’s own file name the class (no second registration elsewhere)', () => {
    expect(filesReferencing(INTERCEPTOR)).toEqual(['app.module.ts', 'authz/remote-refusal/remote-refusal.interceptor.ts']);
  });
});

// The registration check is only as strong as the shapes the parser reads. Pin them.
describe('appInterceptors reads only live @Module provider registrations (meta-guard)', () => {
  const mod = (providers: string, extra = '') =>
    `${extra}\n@Module({ imports: [], providers: [${providers}] })\nexport class AppModule {}`;

  it('reads the registrations in order', () => {
    expect(
      appInterceptors(
        'p.ts',
        mod(`A, { provide: APP_GUARD, useClass: G }, { provide: APP_INTERCEPTOR, useClass: X }, { provide: APP_INTERCEPTOR, useClass: Y }`),
      ),
    ).toEqual(['X', 'Y']);
  });

  it('counts a second registration twice', () => {
    expect(appInterceptors('p.ts', mod(`{ provide: APP_INTERCEPTOR, useClass: X }, { provide: APP_INTERCEPTOR, useClass: X }`))).toEqual([
      'X',
      'X',
    ]);
  });

  it.each([
    ['a commented-out provider', mod(`// { provide: APP_INTERCEPTOR, useClass: X },\n/* { provide: APP_INTERCEPTOR, useClass: X } */`)],
    ['a registration in a string', mod(`"{ provide: APP_INTERCEPTOR, useClass: X }"`)],
    ['a provider object outside @Module', mod('', `const p = { provide: APP_INTERCEPTOR, useClass: X };`)],
    ['a provider under another key', `@Module({ exports: [{ provide: APP_INTERCEPTOR, useClass: X }] }) class M {}`],
    ['a guard, not an interceptor', mod(`{ provide: APP_GUARD, useClass: X }`)],
  ])('ignores %s', (_l, src) => {
    expect(appInterceptors('p.ts', src)).toEqual([]);
  });
});
