import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import * as ts from 'typescript';

/**
 * #763 FITNESS TEST — NOT upstream Docmost code. Static pins (no boot):
 *  - AuthzModule imports RequestTimeoutModule, so the bounds are installed in every app that builds the
 *    authz graph (main and collab-main) without an upstream edit;
 *  - nothing else in the server source assigns `requestTimeout` / `headersTimeout`, so no later write can
 *    re-zero the bound or push `headersTimeout` above it (Node would silently swap them).
 */
const SRC_ROOT = join(__dirname, '..', '..');

describe('#763 request-receipt bounds are mounted and unique', () => {
  it('AuthzModule imports RequestTimeoutModule (read from its @Module decorator)', () => {
    const file = join(SRC_ROOT, 'authz', 'authz.module.ts');
    expect(moduleImports(file, readFileSync(file, 'utf8'))).toContain('RequestTimeoutModule');
  });

  it('only request-timeout.ts assigns requestTimeout / headersTimeout in the server source (specs aside)', () => {
    const writers: string[] = [];
    for (const file of tsFiles(SRC_ROOT)) {
      if (file.endsWith('.spec.ts')) continue;
      const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (n: ts.Node): void => {
        if (
          ts.isBinaryExpression(n) &&
          n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(n.left) &&
          ['requestTimeout', 'headersTimeout'].includes(n.left.name.text)
        ) {
          writers.push(`${relative(SRC_ROOT, file)}: ${n.getText(sf)}`);
        }
        if (
          ts.isPropertyAssignment(n) &&
          ts.isIdentifier(n.name) &&
          ['requestTimeout', 'headersTimeout'].includes(n.name.text)
        ) {
          writers.push(`${relative(SRC_ROOT, file)}: ${n.getText(sf)}`);
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(writers).toEqual(['authz/request-controls/request-timeout.ts: server.requestTimeout = ms']);
  });
});

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

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
