import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';

/**
 * Shared TS-AST helpers for the sink-inventory fitness specs — NOT upstream Docmost code (#502, #598).
 *
 * `space-hard-delete.fitness.spec.ts` and `space-native-create.fitness.spec.ts` pin every occurrence of a sensitive
 * call or SQL statement to the method that encloses it, by parsing source (no imports, no boot), so an upstream bump
 * that adds a path to the sink fails RED. These are the parts both inventories share.
 */

const SKIP_DIRS = new Set(['ee', 'node_modules', 'dist']);

/** The text of a string or template literal (substitutions become ` ${} `), or undefined for anything else. */
export function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((s) => ' ${} ' + s.literal.text).join('');
  }
  return undefined;
}

/**
 * `Class.method` (or the function name) that encloses `node`; `<module>` at top level.
 *
 * A variable declaration owns the node only when it declares a function (`const f = () => …`). A plain local such as
 * `const s = await sql\`…\`` inside a method is attributed to the METHOD: naming it after the local would let a sink
 * move to another method, behind the same local name, with the inventory unchanged.
 */
export function ownerOf(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (
      (ts.isMethodDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n) || ts.isPropertyDeclaration(n)) &&
      n.name &&
      ts.isClassLike(n.parent)
    ) {
      return `${n.parent.name?.text ?? '<anonymous>'}.${n.name.getText()}`;
    }
    if (ts.isConstructorDeclaration(n) && ts.isClassLike(n.parent)) {
      return `${n.parent.name?.text ?? '<anonymous>'}.constructor`;
    }
    if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    ) {
      return n.name.text;
    }
  }
  return '<module>';
}

/** Every non-spec, non-declaration `.ts` file under `dir`, skipping `ee` (never initialized), `node_modules`, `dist`. */
export function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) sourceFiles(full, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}
