/**
 * CCC collab integration — NOT upstream Docmost code (#827, ADR 0036).
 *
 * The reasons and rule names #827's bounds send to the editor. They sit in one file the client's parity test reads
 * (apps/client features/editor-ux/collab-try-later-parity.test.ts finds each `export const NAME = '…'` by name and
 * every quoted `ccc:collab-…` literal), so a rename on either side goes red there. Every reason here must be one the
 * client classifies before it ships: an unknown auth reason takes the #537 path (token refetch, then "lost"), an
 * unknown close reason the provider's 1 s reconnect.
 *
 * Like every connect refusal (auth-refusal.ts), a thrown reason is `{ reason }` with no `message`, so Hocuspocus logs
 * nothing per attempt.
 */

/**
 * The page is being compacted (or is draining to be): a non-detaching try-later. Sent as a socket close with 1013
 * (COLLAB_TRY_LATER_CODE), as the refusal of a join while the resident document drains or compacts, and as the throw of
 * a load whose meter or deadline tripped (Hocuspocus answers the waiting sockets permission-denied with it). The
 * editor waits it out read-only and retries; it never refetches the token and never shows the connection lost.
 */
export const COLLAB_PAGE_COMPACTING_REASON = 'ccc:collab-page-compacting';

/**
 * The value a load throws when its step budget or deadline trips (also a load meter scan's `exit`): `{ reason }`, no
 * `message`. A fresh frozen object per call, so no caller can recognize (or mutate) another's by identity.
 */
export function pageCompactingRefusal(): { readonly reason: string } {
  return Object.freeze({ reason: COLLAB_PAGE_COMPACTING_REASON });
}

/**
 * A socket's load of a page refused because its user is in collab CPU debt (a load is charged to the socket that
 * caused it). Try later, as COLLAB_PAGE_COMPACTING_REASON. A DirectConnection (the API) is never refused with it.
 */
export const COLLAB_LOAD_TRY_LATER_REASON = 'ccc:collab-load-try-later';

/**
 * The client's local copy is of another lineage than the page (it was compacted since): refused with 4422 and
 * `<prefix><current epoch>`, before the server answers anything, so nothing of the new lineage merges into the old copy
 * (or back). It starts with the update guard's REFUSED_REASON_PREFIX on purpose: a pre-#827 editor treats it as a
 * final refusal and its Reload loads the new bundle, instead of looping on a reason it does not know.
 */
export const COLLAB_EPOCH_STALE_REASON_PREFIX = 'ccc:collab-update-refused:epoch-stale:';

/** The refusal reason for a client whose copy is not of `epoch`, the page's current lineage. */
export function epochStaleReason(epoch: number): string {
  return COLLAB_EPOCH_STALE_REASON_PREFIX + String(epoch);
}

/**
 * The epoch an epoch-stale reason names, or null for any other reason (or a malformed one). The client's parser must
 * agree (the parity test).
 */
export function parseEpochStaleReason(reason: string): number | null {
  if (!reason.startsWith(COLLAB_EPOCH_STALE_REASON_PREFIX)) return null;
  const tail = reason.slice(COLLAB_EPOCH_STALE_REASON_PREFIX.length);
  if (!/^(0|[1-9][0-9]{0,14})$/.test(tail)) return null;
  return Number(tail);
}

/**
 * #827's new update-guard rules (`ccc:collab-update-refused:<rule>`, 4422, detaching). Each is Discard-first on the
 * client: what the copy holds cannot be sent as it is.
 *   - frame-too-large: a Step2/Update payload over PAGE_MAX_YDOC_BYTES, refused before it is decoded;
 *   - apply-deadline: a frame whose shadow apply ran out of time twice for this user and page with nothing accepted
 *     in between (the first time is a 1013, so a GC pause passes and a deterministic frame does not);
 *   - page-full: growth of a page still over a structure cap after compaction (its visible content is too big).
 */
export const RULE_FRAME_TOO_LARGE = 'frame-too-large';
export const RULE_APPLY_DEADLINE = 'apply-deadline';
export const RULE_PAGE_FULL = 'page-full';
export const COLLAB_827_RULES = [RULE_FRAME_TOO_LARGE, RULE_APPLY_DEADLINE, RULE_PAGE_FULL] as const;
export type Collab827Rule = (typeof COLLAB_827_RULES)[number];

/**
 * #840's update-guard rules (`ccc:collab-update-refused:<rule>`, 4422, detaching). Both are shapes no honest Yjs client
 * writes (0 hits in the #840 honest corpora), refused because no replay or reload rebuilds what they leave:
 *   - parent-split: a new item beside a neighbour of another parent or key (parent-consistency.ts);
 *   - keyed-split: a live keyed item that is not one standalone value (#847: split by a later delete, it wedges live's
 *     transaction cleanup), or a split of a keyed item the page already holds (a delete of its tail, or an origin
 *     inside it) that leaves a live piece which is not its key's head. Refused in every mode, report mode too.
 * The client shows them as any other refusal (the prefix).
 */
export const RULE_PARENT_SPLIT = 'parent-split';
export const RULE_KEYED_SPLIT = 'keyed-split';
export const COLLAB_840_RULES = [RULE_PARENT_SPLIT, RULE_KEYED_SPLIT] as const;

/**
 * #842's update-guard rule (`ccc:collab-update-refused:<rule>`, 4422, detaching): a struct section whose block count is
 * not its number of distinct clients (Yjs's apply keeps only the last block of a repeated client, its decode returns
 * every one). Never written by an honest encoder. The client shows it as any other crafted shape (`other`). #842's other
 * pre-pass rule, a zero-length struct of any kind, keeps the existing `zero-length` name.
 */
export const RULE_CLIENT_BLOCKS = 'client-blocks';
export const COLLAB_842_RULES = [RULE_CLIENT_BLOCKS] as const;
