import { readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { handlerCalls, scanRoutes } from '../route-guard/static-route-scan';
import { ExportAdmissionInterceptor, GOVERNED_EXPORT_ROUTES, isGovernedExport } from './export-admission.interceptor';
import { ExportAdmissionModule } from './export-admission.module';

/**
 * Export admission FITNESS TEST (#699) — NOT upstream Docmost code.
 *
 * The interceptor acts by `Controller.handler` key, so it is only as good as its key set. Pinned statically (no boot):
 *  - the governed keys are EXACTLY the routes whose handler reaches the export service (`.exportPages(` /
 *    `.exportSpace(`), both directions, so a renamed handler or a new export route goes red instead of unthrottled;
 *  - AuthzModule imports ExportAdmissionModule, which registers the interceptor as its one APP_INTERCEPTOR;
 *  - the export never reads an attachment whole again (`storageService.read(` was its only caller, #699).
 */
const SRC_ROOT = join(__dirname, '..', '..');
const EXPORT_CALL_RE = /\.export(Pages|Space)\s*\(/;

describe('export admission governs every route that runs an export (#699)', () => {
  const routes = scanRoutes(SRC_ROOT);
  const key = (r: { controller: string; handler: string }) => `${r.controller}.${r.handler}`;

  it('scans a meaningful tree', () => {
    expect(routes.length).toBeGreaterThanOrEqual(80);
  });

  it('the governed keys are EXACTLY the routes whose handler reaches the export service', () => {
    const reaching = routes.filter((r) => handlerCalls(r, EXPORT_CALL_RE)).map(key).sort();
    expect(reaching).toEqual([...GOVERNED_EXPORT_ROUTES].sort());
  });

  it('page export is governed only when it builds a zip; space export always', () => {
    expect(isGovernedExport('ExportController.exportPage', { includeChildren: false, includeAttachments: false })).toBe(false);
    expect(isGovernedExport('ExportController.exportPage', {})).toBe(false);
    expect(isGovernedExport('ExportController.exportPage', { includeChildren: true })).toBe(true);
    expect(isGovernedExport('ExportController.exportPage', { includeAttachments: true })).toBe(true);
    expect(isGovernedExport('ExportController.exportSpace', undefined)).toBe(true);
    expect(isGovernedExport('PageController.getPage', { includeChildren: true })).toBe(false);
  });

  it('AuthzModule imports ExportAdmissionModule (read from its @Module decorator)', () => {
    const file = join(SRC_ROOT, 'authz', 'authz.module.ts');
    expect(moduleImports(file, readFileSync(file, 'utf8'))).toContain('ExportAdmissionModule');
  });

  it('ExportAdmissionModule registers the admission interceptor as its one APP_INTERCEPTOR', () => {
    const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ExportAdmissionModule) ?? []) as Array<{
      provide?: unknown;
      useClass?: unknown;
    }>;
    expect(providers.filter((p) => p?.provide === APP_INTERCEPTOR).map((p) => p.useClass)).toEqual([
      ExportAdmissionInterceptor,
    ]);
  });

  it('the export service never reads an attachment whole (no storage .read( call)', () => {
    const file = join(SRC_ROOT, 'integrations', 'export', 'export.service.ts');
    const calls: string[] = [];
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'read') {
        calls.push(n.expression.getText(sf));
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(calls).toEqual([]);
  });
});

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
          if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'imports' && ts.isArrayLiteralExpression(p.initializer)) {
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
