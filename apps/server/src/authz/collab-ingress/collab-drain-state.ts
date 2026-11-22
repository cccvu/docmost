/**
 * CCC collab integration — NOT upstream Docmost code (wiki-v2 #919).
 *
 * Which drain flag a Hocuspocus instance answers to: its gateway's `CollabSocketBounds` (`draining`), bound in the
 * gateway's constructor (seam §3). The hooks, the handler and the persistence seam hold only the instance, so they read
 * the flag through it. A leaf module (no imports), so collab-quiesce.ts and page-write/keep-failed-store.ts can both
 * read it without a cycle. Per instance (a WeakMap), never a process singleton: a spec's own Hocuspocus is unbound.
 */

/** The drain state a Hocuspocus instance answers to (its gateway's `CollabSocketBounds`). */
export interface CollabDrainState {
  readonly draining: boolean;
}

const drains = new WeakMap<object, CollabDrainState>();

/** Seam §3, in the gateway's constructor: `hocuspocus` answers to `state` (the gateway's bounds). */
export function bindCollabDrain(hocuspocus: object, state: CollabDrainState): void {
  drains.set(hocuspocus, state);
}

/** Is the collab drain on for `hocuspocus`? False for an instance no gateway bound. */
export function collabDraining(hocuspocus: unknown): boolean {
  if (!hocuspocus || typeof hocuspocus !== 'object') return false;
  return drains.get(hocuspocus)?.draining === true;
}
