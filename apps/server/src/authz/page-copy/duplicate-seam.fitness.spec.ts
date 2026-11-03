import { readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';

/**
 * #573 FITNESS — the duplicate's copy guard stays wired where it can be sound.
 *
 * The guard is only fail-closed when it runs on the exact set being inserted, INSIDE the insert's transaction, under
 * the workspace lock it takes (an earlier check races a concurrent restrict or move; see `copy-restriction.guard.ts`).
 * That wiring is an upstream seam (#121 in `core/page/services/page.service.ts`), so an upstream bump or a merge can
 * silently drop it. This pins, by source, in `PageService.duplicatePage`:
 *   - there is exactly ONE `insertInto('pages')`, and it runs on the transaction handed to an `executeTx` callback;
 *   - that callback first awaits `this.pagePermissionRepo.assertCopyKeepsRestrictions(<that trx>, …)` behind
 *     `hasCopyRestrictionGuard(this.pagePermissionRepo)`, with the set the insert is built from (`pages`), the root
 *     and the resolved target space — and nothing in between can swallow its refusal (no try/catch).
 * The anti-vacuity block runs the same checker over mutated copies of the method and requires each to go red.
 */
const SERVICE = join(__dirname, '..', '..', 'core', 'page', 'services', 'page.service.ts');

const squash = (s: string) => s.replace(/\s+/g, '').replace(/,([}\])])/g, '$1');

function findMethod(file: ts.SourceFile, cls: string, name: string): ts.MethodDeclaration | undefined {
  let found: ts.MethodDeclaration | undefined;
  const visit = (n: ts.Node) => {
    if (ts.isClassDeclaration(n) && n.name?.text === cls) {
      for (const m of n.members) if (ts.isMethodDeclaration(m) && m.name.getText(file) === name) found = m;
    }
    ts.forEachChild(n, visit);
  };
  visit(file);
  return found;
}

function collect<T extends ts.Node>(root: ts.Node, pick: (n: ts.Node) => n is T): T[] {
  const out: T[] = [];
  const visit = (n: ts.Node) => {
    if (pick(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}

const isCall = (n: ts.Node): n is ts.CallExpression => ts.isCallExpression(n);

/** Every violation of the #573 wiring in `PageService.duplicatePage` of `text` (empty = wired correctly). */
export function duplicateSeamViolations(text: string): string[] {
  const file = ts.createSourceFile('page.service.ts', text, ts.ScriptTarget.Latest, true);
  const method = findMethod(file, 'PageService', 'duplicatePage');
  if (!method?.body) return ['PageService.duplicatePage not found — upstream renamed or moved it: re-seat the #573 seam'];
  const calls = collect(method.body, isCall);
  const out: string[] = [];

  const inserts = calls.filter(
    (c) =>
      ts.isPropertyAccessExpression(c.expression) &&
      c.expression.name.text === 'insertInto' &&
      c.arguments.length > 0 &&
      ts.isStringLiteralLike(c.arguments[0]) &&
      c.arguments[0].text === 'pages',
  );
  if (inserts.length !== 1) out.push(`expected exactly one insertInto('pages') in duplicatePage, found ${inserts.length}`);
  const insert = inserts[0];
  if (!insert) return out;

  // The nearest enclosing function must be an `executeTx(…)` callback, and the insert must run on its trx.
  let fn: ts.Node | undefined = insert.parent;
  while (fn && !ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn) && fn !== method) fn = fn.parent;
  const cb = fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ? fn : undefined;
  const txCall = cb && ts.isCallExpression(cb.parent) ? cb.parent : undefined;
  if (!cb || !txCall || txCall.expression.getText(file) !== 'executeTx' || !txCall.arguments.includes(cb)) {
    out.push("the pages insert is not inside an executeTx(…) callback");
    return out;
  }
  const trxName = cb.parameters[0]?.name.getText(file);
  const receiver = (insert.expression as ts.PropertyAccessExpression).expression.getText(file);
  if (!trxName || receiver !== trxName) {
    out.push(`the pages insert runs on \`${receiver}\`, not on the executeTx callback's transaction`);
  }
  const valuesCall = collect(cb.body, isCall).find(
    (c) =>
      ts.isPropertyAccessExpression(c.expression) &&
      c.expression.name.text === 'values' &&
      c.expression.expression === insert,
  );
  if (!valuesCall || valuesCall.arguments[0]?.getText(file) !== 'insertablePages') {
    out.push('the pages insert no longer inserts `insertablePages`');
  }

  // The guard call: in the same callback, awaited, on the same trx, before the insert, behind the type guard.
  const guards = collect(cb.body, isCall).filter(
    (c) => squash(c.expression.getText(file)) === 'this.pagePermissionRepo.assertCopyKeepsRestrictions',
  );
  if (guards.length !== 1) {
    out.push(`expected exactly one assertCopyKeepsRestrictions call in the executeTx callback, found ${guards.length}`);
    return out;
  }
  const guard = guards[0];
  if (guard.getStart(file) > insert.getStart(file)) out.push('assertCopyKeepsRestrictions runs AFTER the pages insert');
  if (!ts.isAwaitExpression(guard.parent)) out.push('assertCopyKeepsRestrictions is not awaited');
  if (guard.arguments[0]?.getText(file) !== trxName) {
    out.push("assertCopyKeepsRestrictions does not get the executeTx callback's transaction");
  }
  const arg = guard.arguments[1];
  const props = new Map<string, string>();
  if (arg && ts.isObjectLiteralExpression(arg)) {
    for (const p of arg.properties) {
      if (ts.isPropertyAssignment(p)) props.set(p.name.getText(file), squash(p.initializer.getText(file)));
      if (ts.isShorthandPropertyAssignment(p)) props.set(p.name.getText(file), p.name.getText(file));
    }
  }
  if (!props.get('pageIds')?.startsWith('pages.map(')) out.push('pageIds is not the set the insert is built from (`pages`)');
  if (props.get('rootPage') !== 'rootPage') out.push('rootPage is not passed through');
  if (props.get('targetSpaceId') !== 'spaceId') out.push('targetSpaceId is not the resolved target space (`spaceId`)');

  let gated = false;
  for (let n: ts.Node | undefined = guard.parent; n && n !== cb; n = n.parent) {
    if (ts.isTryStatement(n)) out.push('assertCopyKeepsRestrictions sits in a try/catch that could swallow its refusal');
    if (ts.isIfStatement(n) && squash(n.expression.getText(file)) === 'hasCopyRestrictionGuard(this.pagePermissionRepo)') {
      gated = true;
    }
  }
  if (!gated) out.push('assertCopyKeepsRestrictions is not gated by hasCopyRestrictionGuard(this.pagePermissionRepo)');
  // Nor may a try/catch inside the callback wrap the insert (a try around guard and insert would swallow the refusal).
  for (let n: ts.Node | undefined = insert.parent; n && n !== cb; n = n.parent) {
    if (ts.isTryStatement(n)) out.push('the pages insert sits in a try/catch inside the executeTx callback');
  }
  // The pages copied must be built from the same `pages` set the guard sees.
  if (!/constinsertablePages:InsertablePage\[\]=awaitPromise\.all\(pages\.map\(/.test(squash(method.body.getText(file)))) {
    out.push('insertablePages is no longer built from `pages`');
  }
  return out;
}

describe('#573 fitness — duplicatePage inserts only inside the transaction that runs the copy guard', () => {
  const source = readFileSync(SERVICE, 'utf8');

  it('the live page.service.ts is wired correctly', () => {
    expect(duplicateSeamViolations(source)).toEqual([]);
  });

  describe('anti-vacuity: each regression goes red', () => {
    const SEAM_GUARD = /\s*if \(hasCopyRestrictionGuard\(this\.pagePermissionRepo\)\) \{[\s\S]*?\n {6}\}\n/;
    const INSERT_IN_TX = "await trx.insertInto('pages').values(insertablePages).execute();";

    it('fixtures match the live source (so the mutations below really mutate)', () => {
      expect(source).toMatch(SEAM_GUARD);
      expect(source).toContain(INSERT_IN_TX);
    });

    const mutations: Array<[string, (s: string) => string, RegExp]> = [
      ['the guard call removed', (s) => s.replace(SEAM_GUARD, '\n'), /exactly one assertCopyKeepsRestrictions/],
      [
        'the insert moved outside the transaction',
        (s) =>
          s
            .replace(INSERT_IN_TX, '')
            .replace(
              '    // Extract transclusions from every duplicated page',
              "    await this.db.insertInto('pages').values(insertablePages).execute();\n    // Extract transclusions from every duplicated page",
            ),
        /not inside an executeTx/,
      ],
      [
        'the insert inside the callback but on this.db (a second connection, outside the lock)',
        (s) => s.replace(INSERT_IN_TX, "await this.db.insertInto('pages').values(insertablePages).execute();"),
        /runs on `this\.db`/,
      ],
      [
        'a second pages insert added after the transaction',
        (s) =>
          s.replace(
            '    // Extract transclusions from every duplicated page',
            "    await this.db.insertInto('pages').values([]).execute();\n    // Extract transclusions from every duplicated page",
          ),
        /found 2/,
      ],
      [
        'the guard moved after the insert',
        (s) => {
          const guard = s.match(SEAM_GUARD)![0];
          return s.replace(SEAM_GUARD, '\n').replace(INSERT_IN_TX, `${INSERT_IN_TX}\n${guard}`);
        },
        /AFTER the pages insert/,
      ],
      [
        'the guard not awaited',
        (s) => s.replace('await this.pagePermissionRepo.assertCopyKeepsRestrictions(', 'void this.pagePermissionRepo.assertCopyKeepsRestrictions('),
        /not awaited/,
      ],
      [
        'the guard in a try/catch',
        (s) =>
          s.replace(SEAM_GUARD, (g) => `\n      try {${g}      } catch (e) {}\n`),
        /try\/catch that could swallow/,
      ],
      [
        'the guard given a different set',
        (s) => s.replace('pageIds: pages.map((p) => p.id)', 'pageIds: allPages.map((p) => p.id)'),
        /pageIds is not the set/,
      ],
      [
        'the guard given the source space instead of the target',
        (s) => s.replace('targetSpaceId: spaceId,', 'targetSpaceId: rootPage.spaceId,'),
        /targetSpaceId is not the resolved target/,
      ],
      [
        'the guard un-gated',
        (s) =>
          s.replace(SEAM_GUARD, (g) =>
            g.replace('if (hasCopyRestrictionGuard(this.pagePermissionRepo)) {', 'if (true) {'),
          ),
        /not gated by hasCopyRestrictionGuard/,
      ],
      [
        'the executeTx callback swapped for a plain call',
        (s) =>
          s
            .replace(/await executeTx\(this\.db, async \(trx\) => \{(?=\s*if \(hasCopyRestrictionGuard)/, 'await (async (trx) => {')
            .replace(`${INSERT_IN_TX}\n    });`, `${INSERT_IN_TX}\n    })(this.db as never);`),
        /not inside an executeTx/,
      ],
    ];

    it.each(mutations)('%s', (_name, mutate, expected) => {
      const mutated = mutate(source);
      expect(mutated).not.toBe(source);
      const v = duplicateSeamViolations(mutated);
      expect(v.join('\n')).toMatch(expected);
    });
  });
});
