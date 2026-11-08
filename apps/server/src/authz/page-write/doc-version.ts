/**
 * CCC integration — NOT upstream Docmost code (#716, UPSTREAM_MODIFICATIONS.md §2, ADR 0019 note).
 *
 * The live document's content digest (`stableHash(storeSafeJson(fromYdoc(doc)))`), computed at most once per state of the document.
 * A conditional write compares it twice — the pre-check before the direct connection opens, and the authoritative
 * compare inside the transaction — and the settle (`flushPageContent`) hands the same digest out first. Each is three
 * full-page passes (serialize, sorted stringify, sha256), so a page that nobody changed in between was walked up to
 * nine times for one write.
 *
 * Soundness — why a memoized digest can never pass a CAS it should fail:
 *   - every change to a Y.Doc (a local edit, a delete-only edit, a remote update, a load) runs inside a Yjs
 *     transaction, and `afterTransaction` fires synchronously at the end of EVERY transaction, before any other code
 *     runs. The listener below bumps a generation counter there.
 *   - so an unchanged generation means no transaction ran, which means unchanged content, which means the same digest.
 *     A transaction that changed nothing still bumps it; that costs a recompute, never a stale answer.
 *   - the generation is read before computing; if a transaction were to run during the computation the memo is stored
 *     under the OLD generation and the next read recomputes.
 *   - keyed by the Document object (a WeakMap): a document unloaded and reloaded is a new object, recomputed from
 *     scratch; entries vanish with the document.
 * Do NOT key this on `encodeStateVector`: a deletion does not change the state vector, so a stale digest would pass the
 * CAS and lose an update (#716 M1 review).
 */
import type * as Y from 'yjs';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { stableHash } from './stable-hash';
import { storeSafeJson } from './store-safe-json';

interface Version {
  /** Bumped at the end of every transaction on the document. */
  gen: number;
  /** The digest, valid while `gen === digestGen` and only for the function that computed it. */
  digest?: string;
  digestGen: number;
  digestOf?: (doc: Y.Doc) => string;
}

const versions = new WeakMap<object, Version>();

function track(doc: Y.Doc): Version {
  let v = versions.get(doc);
  if (!v) {
    const fresh: Version = { gen: 0, digestGen: -1 };
    v = fresh;
    versions.set(doc, fresh);
    doc.on('afterTransaction', () => {
      fresh.gen++;
    });
  }
  return v;
}

/** The document's mutation generation: changes whenever a transaction has run on it since it was first tracked. */
export function docGeneration(doc: Y.Doc): number {
  // Only for observable documents (see memoizedDigest).
  return track(doc).gen;
}

/**
 * `compute(doc)` for the document's current state, memoized per generation. `compute` must be a pure function of the
 * document's content. There is ONE memo slot per document, so it is also keyed by `compute` itself: a caller passing a
 * different function never reads another function's digest (it recomputes and takes the slot). Pass a stable function
 * reference (a module constant), or every call is a miss.
 */
export function memoizedDigest(doc: Y.Doc, compute: (doc: Y.Doc) => string): string {
  // A document whose transactions cannot be observed is never memoized (fail-safe: always recompute).
  if (typeof (doc as { on?: unknown })?.on !== 'function') return compute(doc);
  const v = track(doc);
  if (v.digest !== undefined && v.digestGen === v.gen && v.digestOf === compute) return v.digest;
  const gen = v.gen;
  const digest = compute(doc);
  v.digest = digest;
  v.digestGen = gen;
  v.digestOf = compute;
  return digest;
}

/**
 * The ADR 0019 content digest. A module constant, so the memo above (keyed on the function) hits across calls.
 * It hashes the STORED projection (`storeSafeJson`, #773), the same JSON the collab store writes: a clean page comes
 * back as the same reference, so its digest is what it always was. For a page holding a lone surrogate, NUL or a
 * non-JSON value (a BigInt makes `JSON.stringify` throw, which failed every settle), the digest is defined and stays
 * the same across an unload and reload, and an edit that changes nothing the store keeps changes no version.
 */
const contentDigest = (d: Y.Doc): string => stableHash(storeSafeJson(TiptapTransformer.fromYdoc(d, 'default')));

/** The live document's content digest — the version a conditional write names (ADR 0019) — memoized per generation. */
export function liveContentDigest(doc: Y.Doc): string {
  return memoizedDigest(doc, contentDigest);
}

/**
 * #731 F4: compute the live digest now if the memo does not hold it for the document's current generation. True when
 * it had to (a page-sized walk ran), false on a hit or for a document whose transactions cannot be observed (that one
 * is never memoized, so warming it would only walk the page twice).
 *
 * The conditional write warms the memo, yields a loop turn, and only then runs its pre-check and transaction, so the
 * digest walk and the transaction are separate event-loop blocks. Sound because the memo is keyed on the generation:
 * an edit that lands during the yield bumps it, and the pre-check (and the authoritative compare inside the
 * transaction) recompute; nothing yields between the pre-check and the transaction (#282).
 */
export function warmLiveContentDigest(doc: Y.Doc): boolean {
  if (typeof (doc as { on?: unknown })?.on !== 'function') return false;
  const v = track(doc);
  if (v.digest !== undefined && v.digestGen === v.gen && v.digestOf === contentDigest) return false;
  memoizedDigest(doc, contentDigest);
  return true;
}
