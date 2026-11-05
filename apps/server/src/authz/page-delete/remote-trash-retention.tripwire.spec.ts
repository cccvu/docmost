import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';
import {
  DEFAULT_RETENTION_DAYS,
  TRASH_CLEANUP_INTERVAL,
  TRASH_CLEANUP_PERIOD_MS,
} from './remote-trash-retention.service';

/**
 * #589 SOURCE TRIPWIRE — `RemoteTrashRetentionService` REPLACES upstream's `TrashCleanupService` in remote mode
 * (seam #183) and must keep its observable contract: the same interval name and period, the same default retention,
 * the same per-workspace retention rule. A replacement drifts silently when upstream changes the original, so this pins
 * the upstream source: an upstream bump that edits `trash-cleanup.service.ts` turns this red, and the fix is to RE-READ
 * it, re-sync the CCC retention (what it selects, when it runs, what it queues), and only then update the pinned digest
 * printed in the failure. Robust to formatting: the class is reduced to its TypeScript token stream.
 */
const SRC = join(__dirname, '..', '..');
const UPSTREAM = 'core/page/services/trash-cleanup.service.ts';
const text = readFileSync(join(SRC, UPSTREAM), 'utf8');
const sf = ts.createSourceFile(UPSTREAM, text, ts.ScriptTarget.Latest, true);
const squash = (s: string) => s.replace(/\s+/g, '');

function tokenStream(src: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, src);
  const out: string[] = [];
  for (let k = scanner.scan(); k !== ts.SyntaxKind.EndOfFileToken; k = scanner.scan()) out.push(scanner.getTokenText());
  return out.filter((t, i) => !(t === ',' && [')', ']', '}'].includes(out[i + 1]))).join(' ');
}

/** The digest of upstream's whole file as last re-synced (v0.95.0). */
const PINNED_DIGEST = 'c7efbfbbdb0f926c';

describe('#589 tripwire — upstream TrashCleanupService, which the remote retention replaces', () => {
  it('is unchanged since the CCC retention was last synced', () => {
    const now = createHash('sha256').update(tokenStream(text)).digest('hex').slice(0, 16);
    if (now !== PINNED_DIGEST) {
      throw new Error(
        `${UPSTREAM} changed upstream (digest ${now}, pinned ${PINNED_DIGEST}). Re-read it, re-sync ` +
          `authz/page-delete/remote-trash-retention.service.ts (interval, default retention, selection, jobs), then pin '${now}'.`,
      );
    }
  });

  it('the default retention is the same 30 days', () => {
    let initializer: string | undefined;
    sf.forEachChild((n) => {
      if (ts.isVariableStatement(n)) {
        for (const d of n.declarationList.declarations) {
          if (d.name.getText(sf) === 'DEFAULT_RETENTION_DAYS') initializer = d.initializer?.getText(sf);
        }
      }
    });
    expect(initializer).toBe('30');
    expect(DEFAULT_RETENTION_DAYS).toBe(Number(initializer));
  });

  it('the interval has the same name and period (one `trash-cleanup` interval: the two classes are alternatives)', () => {
    expect(squash(text)).toContain("@Interval('trash-cleanup',24*60*60*1000)");
    expect(TRASH_CLEANUP_INTERVAL).toBe('trash-cleanup');
    expect(TRASH_CLEANUP_PERIOD_MS).toBe(24 * 60 * 60 * 1000);
    const ccc = readFileSync(join(__dirname, 'remote-trash-retention.service.ts'), 'utf8');
    expect(squash(ccc)).toContain('@Interval(TRASH_CLEANUP_INTERVAL,TRASH_CLEANUP_PERIOD_MS)asynccleanupOldTrash()');
  });

  it('the per-workspace retention rule is the same: live workspaces, `trashRetentionDays ?? default` days back', () => {
    const up = squash(text);
    expect(up).toContain(".select(['id','trashRetentionDays']).where('deletedAt','is',null)");
    expect(up).toContain('workspace.trashRetentionDays??DEFAULT_RETENTION_DAYS');
    expect(up).toContain('retentionDate.setDate(retentionDate.getDate()-retentionDays)');
    const ccc = squash(readFileSync(join(__dirname, 'remote-trash-retention.service.ts'), 'utf8'));
    expect(ccc).toContain(".select(['id','trashRetentionDays']).where('deletedAt','is',null)");
    expect(ccc).toContain('workspace.trashRetentionDays??DEFAULT_RETENTION_DAYS');
    expect(ccc).toContain('cutoff.setDate(cutoff.getDate()-retentionDays)');
  });
});
