import { readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ownerOf, sourceFiles } from '../route-guard/ast-sink-scan';
import { handlerCalls, scanRoutes } from '../route-guard/static-route-scan';
import { BreadcrumbsRedactionInterceptor, PAGE_BREADCRUMBS_ROUTES } from './breadcrumbs-redaction.interceptor';
import { NativeRouteAuthzModule } from './native-route-authz.module';

/**
 * Native route authz FITNESS TEST (#574) — NOT upstream Docmost code.
 *
 * `BreadcrumbsRedactionInterceptor` acts by `Controller.handler` key, so it is only as good as its key set and the
 * call graph behind it. This pins it statically (no imports of the real controllers, no boot):
 *  - the redacted breadcrumb routes are EXACTLY the routes whose handler reaches `.getPageBreadCrumbs(`, both
 *    directions;
 *  - every call site of that sink, per enclosing METHOD (TS AST, so comments never count), so a new path to it fails
 *    RED and whoever adds it decides deliberately whether remote mode must redact it too;
 *  - NativeRouteAuthzModule is in AuthzModule's imports and registers the interceptor as its one APP_INTERCEPTOR.
 * The native space-member writes (#542) are a remote REFUSAL, pinned with the rest of the refusal table in
 * `authz/remote-refusal/space-member.fitness.spec.ts` (every `space_members` write, every hop to a route).
 * A static inventory: a sink reached through an unrecognized indirection (a method passed by reference, a dynamic
 * property name) is invisible to it. The `ee` directory is not scanned: it is never initialized in this repo.
 */
const SRC_ROOT = join(__dirname, '..', '..'); // .../apps/server/src

// Text tell that a handler reaches the unfiltered breadcrumb query (#574): `pageService.getPageBreadCrumbs(`. The
// leading `.` keeps the handler's own declaration (`getPageBreadcrumbs(`) out.
export const PAGE_BREADCRUMBS_CALL_RE = /\.getPageBreadCrumbs\s*\(/;

const SINK_METHODS = [
  // the unfiltered ancestor chain (#574)
  'getPageBreadCrumbs',
] as const;
type SinkMethod = (typeof SINK_METHODS)[number];
const SINK_SET: ReadonlySet<string> = new Set(SINK_METHODS);

/** Every call `x.<sink>(…)` in one source file, as `sink@Owner.method`. Pure; exported for the meta-guard. */
export function scanNativeRouteSinks(fileName: string, source: string): Array<{ sink: SinkMethod; owner: string }> {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out: Array<{ sink: SinkMethod; owner: string }> = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      SINK_SET.has(node.expression.name.text)
    ) {
      out.push({ sink: node.expression.name.text as SinkMethod, owner: ownerOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe('native route authz covers every route that reaches its sink (#574)', () => {
  const routes = scanRoutes(SRC_ROOT);
  const key = (r: { controller: string; handler: string }) => `${r.controller}.${r.handler}`;
  const routeKeys = new Set(routes.map(key));
  const files = sourceFiles(SRC_ROOT).map((full) => {
    const file = full.slice(SRC_ROOT.length + 1).split('\\').join('/');
    const src = readFileSync(full, 'utf8');
    return { file, src, sinks: scanNativeRouteSinks(file, src) };
  });
  const sitesOf = (sink: SinkMethod) =>
    files.flatMap((f) => f.sinks.filter((s) => s.sink === sink).map((s) => `${f.file}:${s.owner}`)).sort();

  it('scans a meaningful tree (guards against a silently-empty scan)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(80);
    expect(files.length).toBeGreaterThanOrEqual(300);
    expect(files.some((f) => f.sinks.length > 0)).toBe(true);
  });

  describe('breadcrumbs (#574)', () => {
    it('every redacted key names a real route', () => {
      expect([...PAGE_BREADCRUMBS_ROUTES].filter((k) => !routeKeys.has(k))).toEqual([]);
    });

    it('the redacted set is EXACTLY the routes whose handler reaches .getPageBreadCrumbs(', () => {
      const reaching = routes.filter((r) => handlerCalls(r, PAGE_BREADCRUMBS_CALL_RE)).map(key).sort();
      expect(reaching).toEqual([...PAGE_BREADCRUMBS_ROUTES].sort());
    });

    it('.getPageBreadCrumbs( is called only by the redacted handler', () => {
      expect(sitesOf('getPageBreadCrumbs')).toEqual(['core/page/page.controller.ts:PageController.getPageBreadcrumbs']);
    });
  });

  describe('wiring', () => {
    it('AuthzModule imports NativeRouteAuthzModule (read from its @Module decorator, not a comment)', () => {
      const file = 'authz/authz.module.ts';
      const src = files.find((f) => f.file === file)?.src ?? '';
      expect(moduleImports(file, src)).toContain('NativeRouteAuthzModule');
    });

    it('NativeRouteAuthzModule registers the redaction interceptor as its one APP_INTERCEPTOR', () => {
      const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, NativeRouteAuthzModule) ?? []) as Array<{
        provide?: unknown;
        useClass?: unknown;
      }>;
      const intercepting = providers.filter((p) => p?.provide === APP_INTERCEPTOR).map((p) => p.useClass);
      expect(intercepting).toEqual([BreadcrumbsRedactionInterceptor]);
    });
  });
});

/** The identifiers in the `imports: [...]` of the `@Module({...})` decorators in a file. */
function moduleImports(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isDecorator(node) &&
      ts.isCallExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Module'
    ) {
      const arg = node.expression.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        for (const p of arg.properties) {
          if (
            ts.isPropertyAssignment(p) &&
            ts.isIdentifier(p.name) &&
            p.name.text === 'imports' &&
            ts.isArrayLiteralExpression(p.initializer)
          ) {
            for (const el of p.initializer.elements) if (ts.isIdentifier(el)) names.push(el.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

// The inventory is only as strong as the shapes the scanner recognizes. Pin them so a later edit cannot quietly
// narrow detection.
describe('the native-route sink scanners recognize every sink shape (meta-guard)', () => {
  const sites = (src: string) => scanNativeRouteSinks('probe.ts', src).map((s) => `${s.sink}@${s.owner}`);

  it('attributes each call to its enclosing method, so a NEW caller in a listed file is caught', () => {
    const src = `class PageController {
      getPageBreadcrumbs() { return this.pageService.getPageBreadCrumbs(id); }
      exportTrail() { return this.pageService.getPageBreadCrumbs(id); }
    }`;
    expect(sites(src)).toEqual([
      'getPageBreadCrumbs@PageController.getPageBreadcrumbs',
      'getPageBreadCrumbs@PageController.exportTrail',
    ]);
  });

  it('sees a call through any receiver, and never a declaration or a comment', () => {
    expect(sites(`class A { a() { svc.getPageBreadCrumbs(id); } }`)).toEqual(['getPageBreadCrumbs@A.a']);
    expect(sites(`class S { getPageBreadCrumbs(id) { return this.repo.findAncestors(id); } }`)).toEqual([]);
    expect(sites(`// this.pageService.getPageBreadCrumbs(id)\nconst x = 1;`)).toEqual([]);
    expect(sites(`class A { a() { this.svc.getPageBreadCrumbsCached(id); } }`)).toEqual([]);
  });

  it('the route tell sees the sink call and not the handler declaration', () => {
    expect(PAGE_BREADCRUMBS_CALL_RE.test('this.pageService.getPageBreadCrumbs(page.id)')).toBe(true);
    expect(PAGE_BREADCRUMBS_CALL_RE.test('async getPageBreadcrumbs(@Body() dto) {}')).toBe(false);
  });

  it('reads module imports from the decorator only', () => {
    expect(moduleImports('m.ts', `@Module({ imports: [A, B] }) class M {}`)).toEqual(['A', 'B']);
    expect(moduleImports('m.ts', `// imports: [NativeRouteAuthzModule]\n@Module({ imports: [A] }) class M {}`)).toEqual(['A']);
    expect(moduleImports('m.ts', `@Module({ providers: [NativeRouteAuthzModule] }) class M {}`)).toEqual([]);
  });
});
