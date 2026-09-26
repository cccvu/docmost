import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';

// The controller module imports PageService, whose graph pulls in the collab stack (lib0 ESM). Stub it.
jest.mock('../../collaboration/collaboration.gateway', () => ({ CollaborationGateway: class {} }));

import { META_FIELDS } from './conditional-page-ops.controller';

/**
 * #616 SOURCE TRIPWIRE — the conditional page operations REPLICATE the native handlers' authorization preambles and
 * side effects (`ConditionalPageOpsController` cannot call the native handlers: the compare has to sit between the
 * locked read and the write). A replica drifts silently when upstream changes the original, so this pins the native
 * sources: an upstream bump that edits one of them turns this red, and the fix is to RE-READ the native handler,
 * re-sync the replica (preamble order, CASL actions, validateCanEdit calls, audit payloads), and only then update
 * the pinned digest printed in the failure.
 *
 * Robust to formatting: a handler is reduced to its TypeScript TOKEN stream (comments and whitespace are trivia,
 * trailing commas are dropped), so a reformat or a new comment does not trip it — a changed token does.
 */
const SRC = join(__dirname, '..', '..');
const read = (rel: string) => {
  const text = readFileSync(join(SRC, rel), 'utf8');
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
};

/** The token stream of `text` (trivia skipped, trailing commas dropped), space-joined. */
export function tokenStream(text: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const out: string[] = [];
  for (let k = scanner.scan(); k !== ts.SyntaxKind.EndOfFileToken; k = scanner.scan()) out.push(scanner.getTokenText());
  return out.filter((t, i) => !(t === ',' && [')', ']', '}'].includes(out[i + 1]))).join(' ');
}
const digest = (text: string) => createHash('sha256').update(tokenStream(text)).digest('hex').slice(0, 16);

function method(file: ts.SourceFile, className: string, name: string): ts.MethodDeclaration {
  let found: ts.MethodDeclaration | undefined;
  const visit = (n: ts.Node) => {
    if (ts.isClassDeclaration(n) && n.name?.text === className) {
      for (const m of n.members) {
        if (ts.isMethodDeclaration(m) && m.name.getText(file) === name) found = m;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(file);
  if (!found) throw new Error(`${className}.${name} not found — upstream renamed it: re-sync the #616 replica`);
  return found;
}

/** Every `<callee>(…)` call inside `node` whose callee text (whitespace-stripped) equals `callee`. */
function calls(file: ts.SourceFile, node: ts.Node, callee: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.expression.getText(file).replace(/\s+/g, '') === callee) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}
const squash = (s: string) => s.replace(/\s+/g, '').replace(/,([}\])])/g, '$1');

/**
 * The native handlers the conditional routes replicate, and the digest of each as last re-synced. On a red: diff the
 * native handler against its replica in conditional-page-ops.controller.ts, re-sync, then paste the new digest.
 * Pinned at upstream v0.95.0 (page.controller.ts is not a seam file — the fork does not modify it).
 */
const PINNED: Record<string, { replica: string; digest: string }> = {
  'PageController.delete': { replica: 'conditionalDelete', digest: '4ff686296be38b1d' },
  'PageController.movePage': { replica: 'conditionalMove', digest: '983e3fcf4aa37308' },
  'PageController.movePageToSpace': { replica: 'conditionalMoveToSpace', digest: '3d88a3c7cdd06806' },
  'PageController.update': { replica: 'conditionalUpdateMeta', digest: '265b96c575a4cb5c' },
};

describe('#616 tripwire — the replicated native page-handler preambles', () => {
  const controller = read('core/page/page.controller.ts');

  it.each(Object.entries(PINNED))('%s is unchanged since its replica was last synced', (key, pin) => {
    const [cls, name] = key.split('.');
    const now = digest(method(controller, cls, name).getText(controller));
    if (now !== pin.digest) {
      throw new Error(
        `${key} changed upstream (digest ${now}, pinned ${pin.digest}). Re-read it, re-sync ` +
          `ConditionalPageOpsController.${pin.replica} (authorization order, CASL actions, validateCanEdit calls, ` +
          `refusal messages, audit payloads), then pin '${now}'.`,
      );
    }
  });

  it('the digest ignores formatting and comments, but not a changed token (the tripwire is not vacuous)', () => {
    const src = method(controller, 'PageController', 'movePage').getText(controller);
    const reformatted = src.replace(/\n\s*/g, '\n\n      ').replace('{', '{ // a new comment\n /* and another */');
    expect(digest(reformatted)).toBe(digest(src));
    expect(digest(src.replace('SpaceCaslAction.Edit', 'SpaceCaslAction.Read'))).not.toBe(digest(src));
    expect(digest(src.replace('validateCanEdit(targetParent', 'validateCanView(targetParent'))).not.toBe(digest(src));
  });
});

describe('#616 tripwire — the PageService behaviour the replicas depend on', () => {
  const service = read('core/page/services/page.service.ts');
  const ops = read('authz/page-write/conditional-page-ops.controller.ts');

  it('update() writes exactly title/icon from the request — the fields metadata convergence compares', () => {
    const [write] = calls(service, method(service, 'PageService', 'update'), 'this.pageRepo.updatePage');
    const obj = write.arguments[0];
    expect(ts.isObjectLiteralExpression(obj)).toBe(true);
    const fromRequest = (obj as ts.ObjectLiteralExpression).properties
      .filter((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p))
      .filter((p) => p.initializer.getText(service).startsWith('updatePageDto.'))
      .map((p) => p.name.getText(service));
    expect(fromRequest).toEqual([...META_FIELDS]);
  });

  it('forceDelete() skips its attachment jobs under a caller transaction (the seam), and the replica queues the SAME job', () => {
    const force = method(service, 'PageService', 'forceDelete');
    expect(squash(force.getText(service))).toContain('for(constidoftrx?[]:pageIds)');
    const [upstream] = calls(service, force, 'this.attachmentQueue.add');
    const [replica] = calls(ops, method(ops, 'ConditionalPageOpsController', 'queueAttachmentDeletion'), 'this.attachmentQueue.add');
    const expected = [
      'QueueJob.DELETE_PAGE_ATTACHMENTS',
      '{pageId:id}',
      "{jobId:`delete-page-attachments-${id}`,attempts:3,backoff:{type:'exponential',delay:5000}}",
    ];
    expect(upstream.arguments.map((a) => squash(a.getText(service)))).toEqual(expected);
    expect(replica.arguments.map((a) => squash(a.getText(ops)))).toEqual(expected);
  });
});
