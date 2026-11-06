/**
 * #626 + #716 fitness function: untrusted HTML/Markdown is converted, and stored pages are serialized back to
 * HTML/Markdown, ONLY inside the conversion worker.
 *
 * On the main thread these conversions have no bound (seconds to minutes of blocked event loop, or an exhausted
 * heap, for one write). `parseUntrustedContent` / `untrustedMarkdownToHtml` run them in the bounded worker; a new
 * direct use of the underlying functions anywhere else would quietly bring the unbounded cost back. This scans every
 * non-spec server source with the TypeScript AST (so comments and strings do not count) and fails on any use outside
 * the allowlist below.
 *
 * Run in CI via the `docmost-authz` job's jest glob (`… src/editor-compat …`).
 */
import { readdirSync, readFileSync } from 'fs';
import { join, relative, resolve, sep } from 'path';
import * as ts from 'typescript';

const SRC_ROOT = resolve(__dirname, '..', '..');

/** Where each conversion function may be used (paths relative to apps/server/src). */
const ALLOWED: Record<string, string[]> = {
  // The worker is the one place that runs the conversions.
  htmlToJson: ['editor-compat/content-parse/content-parse.worker.ts'],
  markdownToHtml: ['editor-compat/content-parse/content-parse.worker.ts'],
  // generateJSON is htmlToJson's own first step.
  generateJSON: ['collaboration/collaboration.util.ts'],
  // #716: the serializations (a happy-dom window, and for Markdown a jsdom one, per page). The worker runs them for
  // the export (`serialize`); collaboration.util composes them. page.controller.ts keeps upstream's `format` echo for
  // NATIVE (standalone) mode only: in remote mode a non-json `format` on /api/pages/info|create|update is refused before
  // the handler (authz/native-format), and nothing on the platform side sends one.
  jsonToHtml: [
    'editor-compat/content-parse/content-parse.worker.ts',
    'collaboration/collaboration.util.ts', // jsonToMarkdown's own first step
    'core/page/page.controller.ts',
  ],
  jsonToMarkdown: ['core/page/page.controller.ts'],
  htmlToMarkdownReleasingDom: ['editor-compat/content-parse/content-parse.worker.ts', 'collaboration/collaboration.util.ts'],
  // jsonToHtml's own first step.
  generateHTML: ['collaboration/collaboration.util.ts'],
};

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

/**
 * Every place a file uses one of the names, other than its own declaration. An import or re-export counts too, so an
 * alias (`import { htmlToJson as parse }`) or a pass-through re-export cannot hide a use; so does a property access or
 * a destructured `require()`, since those name the function as well.
 */
const usesIn = (file: string, text = readFileSync(file, 'utf8')): Array<{ name: string; line: number }> => {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: Array<{ name: string; line: number }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && Object.prototype.hasOwnProperty.call(ALLOWED, node.text)) {
      const p = node.parent;
      const declaration = ts.isFunctionDeclaration(p) && p.name === node;
      if (!declaration) found.push({ name: node.text, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
};

describe('#626/#716 untrusted content is converted, and pages serialized, only in the bounded worker', () => {
  const files = walk(SRC_ROOT, []);
  const uses = files.flatMap((file) =>
    usesIn(file).map((u) => ({ ...u, file: relative(SRC_ROOT, file).split(sep).join('/') })),
  );

  it('scanned the server sources (not a silently empty walk)', () => {
    expect(files.length).toBeGreaterThan(500);
    // Each allowed use really exists, so the allowlist cannot go stale unnoticed.
    for (const [name, where] of Object.entries(ALLOWED)) {
      for (const file of where) expect(uses).toContainEqual(expect.objectContaining({ name, file }));
    }
  });

  it('catches a use however it is named: alias, re-export, property access, destructured require', () => {
    const cases = [
      `import { htmlToJson as parse } from '../../collaboration/collaboration.util';`,
      `export { markdownToHtml } from '@docmost/editor-ext';`,
      `import * as util from '../../collaboration/collaboration.util'; util.htmlToJson('<p>x</p>');`,
      `const { generateJSON: g } = require('../../common/helpers/prosemirror/html');`,
      // #716: a main-thread serialization, however it is reached.
      `import { jsonToMarkdown } from '../../collaboration/collaboration.util'; jsonToMarkdown(x);`,
      `export { htmlToMarkdownReleasingDom } from '../html-to-markdown';`,
      `import { generateHTML } from '../../common/helpers/prosemirror/html'; generateHTML(doc, ext);`,
    ];
    for (const source of cases) expect(usesIn('probe.ts', source)).not.toEqual([]);
    // Anti-vacuity: the same shapes naming something else are not uses.
    expect(usesIn('probe.ts', `import { jsonToText as t } from '../../collaboration/collaboration.util';`)).toEqual([]);
  });

  it('no other server code calls a conversion or a serialization (htmlToJson … jsonToMarkdown, generateHTML)', () => {
    const offenders = uses.filter((u) => !ALLOWED[u.name].includes(u.file)).map((u) => `${u.file}:${u.line} ${u.name}`);
    // Convert through parseUntrustedContent / untrustedMarkdownToHtml, serialize through serializePageContent
    // (editor-compat/content-parse) instead.
    expect(offenders).toEqual([]);
  });
});

/**
 * #642: one human = one admission key. A batch queue that names no human gives its work a turn of its own beside that
 * human's requests, so every `batchConversion(...)` call outside content-parse must pass the user who started the
 * work as its second argument (the zip import: the file task's creator).
 */
describe('#642 every batch conversion names the human who started it', () => {
  const batchCalls = (file: string, text = readFileSync(file, 'utf8')): Array<{ line: number; args: string[] }> => {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const found: Array<{ line: number; args: string[] }> = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'batchConversion') {
        found.push({
          line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          args: node.arguments.map((a) => a.getText(sf)),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
  };
  const files = walk(SRC_ROOT, []).filter((f) => !f.includes(`${sep}editor-compat${sep}content-parse${sep}`));
  const calls = files.flatMap((file) =>
    batchCalls(file).map((c) => ({ ...c, file: relative(SRC_ROOT, file).split(sep).join('/') })),
  );

  it('the zip import passes the file task creator', () => {
    expect(calls).toContainEqual(
      expect.objectContaining({
        file: 'integrations/import/services/file-import-task.service.ts',
        args: ['`file-task:${fileTask.id}`', 'fileTask.creatorId'],
      }),
    );
  });

  it('no call leaves the human out', () => {
    expect(batchCalls('probe.ts', 'batchConversion(`file-task:${id}`);')).toHaveLength(1); // anti-vacuity
    expect(calls.filter((c) => c.args.length < 2).map((c) => `${c.file}:${c.line}`)).toEqual([]);
  });
});
