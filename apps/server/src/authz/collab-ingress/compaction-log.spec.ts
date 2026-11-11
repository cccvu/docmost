import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import * as ts from 'typescript';
import {
  COLLAB_COMPACTION_FAILED_TOKEN,
  COLLAB_PAGE_COMPACTION_TOKEN,
  logCompactionFailed,
  logCompactionRequested,
  logPageCompaction,
} from './compaction-log';

/**
 * #827: the compaction lines have ONE format (the collab-ingress one: token, space, one JSON object) and ONE emitter,
 * used by the update guard and by page-write/compaction.ts alike.
 */
const SRC = join(__dirname, '..', '..');

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'node_modules') sources(p, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.testkit.ts')) out.push(p);
  }
  return out;
}

/** The string and template-literal texts of `file` (comments are not code). */
function literals(file: string, text = readFileSync(file, 'utf8')): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
const TOKEN = /COLLAB_PAGE_COMPACTION\b|COLLAB_COMPACTION_FAILED\b/;

describe('#827 compaction log lines', () => {
  const sink = () => {
    const lines: Array<{ level: string; line: string; trace?: unknown }> = [];
    return {
      lines,
      warn: (line: string) => lines.push({ level: 'warn', line }),
      error: (line: string, trace?: unknown) => lines.push({ level: 'error', line, trace }),
    };
  };

  it('are the token, one space and one JSON object with the discriminator first', () => {
    const s = sink();
    logCompactionRequested('p1', { reason: 'structs', userId: 'u1', drain: true }, { structs: 10, clientIds: 2, steps: undefined }, s);
    logCompactionRequested('p1', { reason: 'probe', userId: null, drain: false }, null, s);
    logPageCompaction('skipped', 'p2', { reason: 'structs', why: 'cas_lost' }, s);
    const err = new Error('boom');
    logCompactionFailed('p3', 'structs', 'deadline', err, s);
    expect(s.lines.map((l) => l.line)).toEqual([
      `${COLLAB_PAGE_COMPACTION_TOKEN} {"event":"requested","pageId":"p1","reason":"structs","drain":true,"userId":"u1","structs":10,"clientIds":2}`,
      `${COLLAB_PAGE_COMPACTION_TOKEN} {"event":"requested","pageId":"p1","reason":"probe","drain":false}`,
      `${COLLAB_PAGE_COMPACTION_TOKEN} {"event":"skipped","pageId":"p2","reason":"structs","why":"cas_lost"}`,
      `${COLLAB_COMPACTION_FAILED_TOKEN} {"pageId":"p3","reason":"structs","why":"deadline"}`,
    ]);
    expect(s.lines[3]).toMatchObject({ level: 'error', trace: err });
  });

  it('are written by this module only: no other server source has either token in a string', () => {
    const spelled = sources(SRC)
      .filter((file) => literals(file).some((text) => TOKEN.test(text)))
      .map((file) => relative(SRC, file).split(sep).join('/'));
    expect(spelled).toEqual(['authz/collab-ingress/compaction-log.ts']);
    // anti-vacuity: the scan finds the shapes the guard and compaction.ts used before (a quoted token, a template), and
    // not a comment
    const finds = (src: string) => literals('x.ts', src).some((text) => TOKEN.test(text));
    expect(finds("this.log('COLLAB_PAGE_COMPACTION', live, {});")).toBe(true);
    expect(finds('logger.warn(`COLLAB_PAGE_COMPACTION skipped page=${id} why=${why}`);')).toBe(true);
    expect(finds('logger.error(`COLLAB_COMPACTION_FAILED page=${id}`);')).toBe(true);
    expect(finds('// COLLAB_PAGE_COMPACTION done\nconst a = 1;')).toBe(false);
    // anti-vacuity: the scan reads this module and both callers
    const all = sources(SRC).map((file) => relative(SRC, file).split(sep).join('/'));
    expect(all).toEqual(expect.arrayContaining(['authz/collab-ingress/compaction-log.ts', 'authz/collab-ingress/update-guard.ts', 'authz/page-write/compaction.ts']));
  });
});
