/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * The outcome shapes the collaboration handler's two #282 custom events return, declared ONCE so the
 * producer and both consumers are tied together by the compiler.
 *
 * `reason` is a LITERAL union on purpose. These strings are load-bearing control flow, not diagnostics:
 * `'error'` is what makes a failed settle fail a guarded content write CLOSED, and it is the only thing
 * separating "we could not settle" from "nothing was resident" — which are otherwise the same
 * `{ flushed: false }`. Recovered by hand-written `as` casts on each side, a rename in the handler would
 * compile clean and silently return the page to the #282 lost update: the caller would read the failure
 * as "no live document to race with" and write unconditionally over somebody's unsaved text.
 *
 * Kept in the fork's own tree rather than in the upstream handler so the seam stays a thin import rather
 * than a widening of an upstream-owned file (`collaboration.handler.ts` already imports `stable-hash`
 * from here; that file is the allowlisted seam, so this adds no new boundary grant).
 */

/**
 * `flushPageContent` — settle a page's live document.
 *
 * Flat rather than a discriminated union deliberately: `apps/server/tsconfig.json` sets
 * `strictNullChecks: false`, under which narrowing a union on an optional discriminant collapses to
 * `never`. The literal `reason` type is what actually does the work here, and it survives.
 */
export type FlushPageContentOutcome = {
  /** Whether a pending store was run. FALSE also covers "nothing was resident", which is SAFE. */
  flushed: boolean;
  /** Present ONLY on a genuine failure. Its absence with `flushed: false` means "nothing to settle". */
  reason?: 'error';
  /** The live document's digest. Present iff a digest was requested AND a document was resident. */
  contentDigest?: string;
};

/** `conditionalUpdatePageContent` — the compare-and-swap content write. */
export type ConditionalUpdateOutcome = {
  applied: boolean;
  /**
   * `'precondition'` is the caller's own concurrency answer (→ 412). Anything else means we could not
   * establish the precondition at all (→ 503); neither may ever be read as "applied".
   */
  reason?: 'precondition' | 'error' | 'unknown';
};
