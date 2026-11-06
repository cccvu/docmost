import * as ts from 'typescript';

/**
 * CCC fitness-test helper — NOT upstream Docmost code. Reads the global interceptor registrations of a module file from
 * its TS AST, so a commented-out, stringified or stray provider never counts. Shared by the remote refusal (#636) and
 * remote step-up (#713) fitness specs; its meta-guard lives in remote-refusal.fitness.spec.ts.
 */

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
