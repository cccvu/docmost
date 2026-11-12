/**
 * #827 fitness function: what runs under a deadline keeps out of async context.
 *
 * `runWithDeadline` (deadline.ts) terminates the work it runs, skipping every `finally` inside, Node's own included. A
 * store entered there (AsyncLocalStorage, nestjs-cls) would stay current for the caller and its later callbacks, and
 * an AsyncResource scope (or a nested deadline, whose call enters one) cut inside aborts the process on a corrupted
 * async-hook stack. This scans every non-spec server source with the TypeScript AST and fails when:
 *   - a `runWithDeadline` call's work is not an inline function (the scan could not see what it runs);
 *   - that function's body names async context (the list below), or calls `runWithDeadline` again;
 *   - a file that calls `runWithDeadline` imports async context at all (what its inline work calls stays in reach).
 * It cannot follow calls out of the file: the deadline's work must stay pure Yjs on a disposable document.
 *
 * Run in CI via the `docmost-authz` job's jest glob (`… src/authz …`).
 */
import { readdirSync, readFileSync } from 'fs';
import { join, relative, resolve, sep } from 'path';
import * as ts from 'typescript';

const SRC_ROOT = resolve(__dirname, '..', '..');
const DEADLINE_MODULE = 'authz/collab-ingress/deadline.ts';

/** Names that reach async context. */
const BANNED_NAMES = new Set([
  'AsyncLocalStorage',
  'AsyncResource',
  'runInAsyncScope',
  'enterWith',
  'getStore',
  'executionAsyncResource',
  'ClsService',
  'ClsServiceManager',
  'runWithDeadline',
  'vmRunWithDeadline',
]);
/** Modules that provide it. */
const BANNED_MODULES = new Set(['async_hooks', 'node:async_hooks', 'nestjs-cls']);

const walk = (dir: string, out: string[]): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', '__fixtures__', 'ee'].includes(entry.name)) walk(full, out);
    } else if (/\.ts$/.test(entry.name) && !/\.(spec|testkit|d)\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
};

type Finding = { file: string; line: number; why: string };

const findingsIn = (file: string, text: string): Finding[] => {
  const rel = relative(SRC_ROOT, file).split(sep).join('/');
  if (rel === DEADLINE_MODULE) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const at = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const found: Finding[] = [];
  const calls: ts.CallExpression[] = [];
  const imports: Array<{ node: ts.Node; module: string }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
      if (name === 'runWithDeadline' || name === 'vmRunWithDeadline') calls.push(node);
      if (ts.isIdentifier(callee) && callee.text === 'require' && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        imports.push({ node, module: node.arguments[0].text });
      }
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) imports.push({ node, module: node.moduleSpecifier.text });
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (calls.length === 0) return [];
  for (const imp of imports) {
    if (BANNED_MODULES.has(imp.module)) found.push({ file: rel, line: at(imp.node), why: `imports ${imp.module} beside a deadline call` });
  }
  for (const call of calls) {
    const work = call.arguments[0];
    if (!work || !(ts.isArrowFunction(work) || ts.isFunctionExpression(work))) {
      found.push({ file: rel, line: at(call), why: 'the deadline work is not an inline function' });
      continue;
    }
    const inner = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && BANNED_NAMES.has(node.text)) found.push({ file: rel, line: at(node), why: `names ${node.text} under a deadline` });
      ts.forEachChild(node, inner);
    };
    inner(work.body);
  }
  return found;
};

describe('deadline work keeps out of async context (#827)', () => {
  it('no deadline call in the server breaks the rules', () => {
    const findings = walk(SRC_ROOT, []).flatMap((f) => findingsIn(f, readFileSync(f, 'utf8')));
    expect(findings).toEqual([]);
  });

  it('is not vacuous: it flags each rule, and passes pure Yjs work', () => {
    const scan = (src: string) => findingsIn(join(SRC_ROOT, 'authz/x.ts'), src).map((f) => f.why);
    expect(scan(`runWithDeadline(() => Y.applyUpdate(shadow, u), T);`)).toEqual([]);
    expect(scan(`this.deadline.runWithDeadline(function () { return Y.encodeStateAsUpdate(d); }, T);`)).toEqual([]);
    expect(scan(`runWithDeadline(apply, T);`)).toEqual(['the deadline work is not an inline function']);
    expect(scan(`runWithDeadline(() => { als.enterWith({}); Y.applyUpdate(d, u); }, T);`)).toEqual(['names enterWith under a deadline']);
    expect(scan(`runWithDeadline(() => this.cls.getStore(), T);`)).toEqual(['names getStore under a deadline']);
    expect(scan(`runWithDeadline(() => new AsyncResource('x').runInAsyncScope(f), T);`)).toEqual([
      'names AsyncResource under a deadline',
      'names runInAsyncScope under a deadline',
    ]);
    expect(scan(`runWithDeadline(() => runWithDeadline(() => 1, 5), T);`)).toEqual(['names runWithDeadline under a deadline']);
    expect(scan(`import { ClsService } from 'nestjs-cls';\nrunWithDeadline(() => 1, T);`)).toEqual(['imports nestjs-cls beside a deadline call']);
    expect(scan(`import { AsyncLocalStorage } from 'node:async_hooks';\nrunWithDeadline(() => 1, T);`)).toEqual(['imports node:async_hooks beside a deadline call']);
    // a file with no deadline call may use async context as it likes
    expect(scan(`import { AsyncLocalStorage } from 'node:async_hooks';\nnew AsyncLocalStorage().enterWith({});`)).toEqual([]);
  });

  it('the deadline module itself is the one place that holds an AsyncResource scope around the vm call', () => {
    const src = readFileSync(join(SRC_ROOT, DEADLINE_MODULE), 'utf8');
    expect(src).toMatch(/new AsyncResource\('CCC_COLLAB_DEADLINE'\)\.runInAsyncScope\(/);
    expect(src).toMatch(/if \(running\) throw new NestedDeadlineError\(\);/);
  });
});
