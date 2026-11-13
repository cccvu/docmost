/**
 * CCC collab integration — NOT upstream Docmost code (#840). NOT a jest suite and not built (`.testkit.ts`).
 *
 * An in-memory heal store (heal-image.ts) and compaction store over one fake `pages` row, for the persistence unit
 * specs: pass it as the extension's `db`. heal-image.pg.spec.ts runs the Postgres stores.
 */
import { createHash } from 'node:crypto';
import type { CompactionStore } from './compaction';
import type { HealImageStore } from './heal-image';
import type { SealRow } from './binding-seal';

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('base64');
const md5 = (text: string): string => createHash('md5').update(text).digest('hex');

export type MemoryHeal = { image: Uint8Array | null; rowSha: string; epoch: number; contentDigest?: string | null };
/** #793: the binding seal rows by page id (binding-seal.ts's table). */
export type MemoryHealStore = HealImageStore & CompactionStore & { heals: Map<string, MemoryHeal>; seals: Map<string, SealRow> };

/** `row` is the spec's fake row (read and written in place); `heals` the heal rows by page id. */
export function memoryHealStore(row: { ydoc: Uint8Array | null; content?: unknown } = { ydoc: null }): MemoryHealStore {
  const heals = new Map<string, MemoryHeal>();
  const seals = new Map<string, SealRow>();
  const current = () => (row.ydoc ? sha(row.ydoc) : null);
  return {
    heals,
    seals,
    async read(pageId) {
      const h = heals.get(pageId);
      return h ? { contentDigest: null, ...h, currentSha: current() } : null;
    },
    async readYdoc() {
      return row.ydoc ? new Uint8Array(row.ydoc) : null;
    },
    async readContent() {
      const text = row.content === undefined || row.content === null ? null : JSON.stringify(row.content);
      return { content: text === null ? null : JSON.parse(text), contentHash: text === null ? null : md5(text), currentSha: current() };
    },
    async dropStale(pageId, rowSha) {
      if (heals.get(pageId)?.rowSha === rowSha && current() !== rowSha) heals.delete(pageId);
    },
    async clear(_trx, pageId, ydoc) {
      const had = heals.delete(pageId);
      if (had && ydoc) row.ydoc = Buffer.from(ydoc);
      return had && !!ydoc;
    },
    async put(_trx, pageId, heal, ydoc) {
      if (ydoc) row.ydoc = Buffer.from(ydoc);
      heals.set(pageId, { ...heal });
    },
    async readRow() {
      return { content: row.content ?? null, ydoc: row.ydoc ? new Uint8Array(row.ydoc) : null, contentHash: null };
    },
    async swapYdoc(pageId, next, { covered, contentHash }) {
      if (current() !== covered) return { swapped: false, why: 'cas_miss' };
      if (contentHash !== undefined && (row.content == null ? null : md5(JSON.stringify(row.content))) !== contentHash) {
        return { swapped: false, why: 'cas_miss' };
      }
      const before = row.ydoc?.length ?? null;
      row.ydoc = Buffer.from(next);
      heals.delete(pageId);
      seals.delete(pageId); // #793: the epoch moved
      return { swapped: true, beforeBytes: before };
    },
    async claimSeal(pageId, lifetimeId) {
      const prev = seals.get(pageId) ?? null;
      seals.set(pageId, { lifetimeId, epoch: null, rowSha: null, entries: null });
      return prev && { ...prev, entries: prev.entries && prev.entries.map((e) => [...e] as typeof e) };
    },
    async commitSeal(pageId, lifetimeId, claimed, seal) {
      const row = seals.get(pageId);
      if (claimed ? row?.lifetimeId !== lifetimeId : row !== undefined) return 0;
      seals.set(pageId, { lifetimeId, epoch: seal.epoch, rowSha: seal.rowSha, entries: seal.entries.map((e) => [...e] as typeof e) });
      return 1;
    },
  };
}
