import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * wiki-v2 #919 fitness — NOT upstream Docmost code. The quiesce must hold until the process exits (the maintenance
 * window's FENCE relies on it: after the ALB rule nothing may write collab state), so the drain flag is lifted in
 * exactly one place, reached from exactly one route:
 *   - only socket-bounds.ts clears `drainingSince` (in `endDrain`);
 *   - only the gateway's `endQuiesce` calls `endDrain`;
 *   - only the abort route (`CollabQuiesceController.abort`) calls `endQuiesce`.
 * And the shutdown and the route run the same drain: `runCollabDrain` is called from the gateway only, once for each.
 * A text scan of every production source (specs and testkits excluded); each list is checked both ways.
 */
const SRC = join(__dirname, '..', '..');

function productionSources(dir = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') out.push(...productionSources(full));
    } else if (/\.ts$/.test(entry.name) && !/\.(spec|testkit|d)\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}
const files = productionSources().map((f) => ({ file: relative(SRC, f).split(sep).join('/'), text: readFileSync(f, 'utf8') }));
const count = (re: RegExp) =>
  files
    .map(({ file, text }) => [file, (text.match(re) ?? []).length] as const)
    .filter(([, n]) => n > 0)
    .map(([file, n]) => `${file}:${n}`);

describe('#919 the collab drain is lifted only by the quiesce abort', () => {
  it('scans a meaningful tree', () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it('only endDrain clears the flag', () => {
    expect(count(/drainingSince\s*=\s*null\s*;/g)).toEqual(['authz/collab-ingress/socket-bounds.ts:1']);
    const bounds = files.find((f) => f.file === 'authz/collab-ingress/socket-bounds.ts')!.text;
    expect(bounds).toMatch(/endDrain\(\): void \{\s*this\.drainingSince = null;/);
  });

  it('only the gateway calls endDrain, and only the abort route calls endQuiesce', () => {
    expect(count(/\.endDrain\s*\(/g)).toEqual(['collaboration/collaboration.gateway.ts:1']);
    expect(count(/\.endQuiesce\s*\(/g)).toEqual(['authz/collab/collab-quiesce.controller.ts:1']);
    const controller = files.find((f) => f.file === 'authz/collab/collab-quiesce.controller.ts')!.text;
    expect(controller).toMatch(/@Post\('quiesce\/abort'\)\s*abort\(\)[^\n]*\{\s*this\.gateway\.endQuiesce\(\);/);
  });

  it('the shutdown and the route run the same drain function, from the gateway only', () => {
    expect(count(/runCollabDrain\s*\(/g)).toEqual(['authz/collab-ingress/collab-quiesce.ts:1', 'collaboration/collaboration.gateway.ts:2']);
    const gateway = files.find((f) => f.file === 'collaboration/collaboration.gateway.ts')!.text;
    expect(gateway).toMatch(/quiesce\(\)[^\n]*\{\s*return runCollabDrain\(this\.hocuspocus, this\.collabSocketBounds, \{ trigger: 'quiesce' \}\)/);
    expect(gateway).toMatch(/async destroy\([\s\S]*?await runCollabDrain\(this\.hocuspocus, this\.collabSocketBounds, \{\s*trigger: 'shutdown'/);
  });

  it('anti-vacuity: the scan sees a second clearer, caller or drain if one is added', () => {
    const probe = 'x.endDrain(); y.endQuiesce(); this.drainingSince = null; runCollabDrain(a, b, c);';
    expect((probe.match(/\.endDrain\s*\(/g) ?? []).length).toBe(1);
    expect((probe.match(/\.endQuiesce\s*\(/g) ?? []).length).toBe(1);
    expect((probe.match(/drainingSince\s*=\s*null\s*;/g) ?? []).length).toBe(1);
    expect((probe.match(/runCollabDrain\s*\(/g) ?? []).length).toBe(1);
  });
});
