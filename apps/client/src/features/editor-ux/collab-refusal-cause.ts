/**
 * CCC fork addition (cccvu/wiki-v2#781 lineage, the ledger-echo incident) — which refusal notice copy a refused editor
 * shows (`collab-refusal-notice.tsx`). The server names the rule it refused a frame on
 * (`ccc:collab-update-refused:<rule>`, `collab-access.ts` keeps it as `refusedRule`); this maps every rule the server
 * guard has (`CollabRule`, apps/server/src/authz/collab-ingress/content-rules.ts) to one cause:
 *
 *   - `change`: a value or shape rule a change made in this browser broke (a schema skew during a rolling deploy,
 *     legacy content, a very large paste, or an earlier visit's edit replayed from IndexedDB), and #827's size and
 *     time bounds (`frame-too-large`, `apply-deadline`, `page-full`, whose notices are Discard-first by `refusalKind`).
 *     Only this cause may say a change was not saved.
 *   - `copy`: this browser's stored copy of the page disagrees with the server (a top-level `root` the SPA never writes
 *     is the IndexedDB echo of server-written state; a client id bound to someone else; more new client ids than a
 *     frame may carry, which a copy collects one per visit). Never "your changes": the user may have typed nothing.
 *       - `unresolved` never arrives with the refused prefix: the server answers it with its own reason
 *         (`ccc:collab-update-unresolved`), and `collab-access.ts` records `"unresolved"` itself when a second one
 *         arrives before every sent frame was applied. It is listed so the client value has a cause; the parity test
 *         holds it because the server union names it too.
 *   - `other`: the server could not decide (`internal`, `shadow-unavailable`; either can repeat for the same copy, so
 *     Discard stays on offer), protocol rules this SPA never trips (stateless, auth, message-type, awareness,
 *     undecodable), a crafted frame no honest editor sends (`cross-list`), and anything this bundle does not know: a
 *     rule a newer server adds, a missing rule, or a hostile string. Generic copy that claims nothing.
 *
 * Lookups go through `ReadonlySet.has`, so a rule such as `__proto__` or `constructor` can never reach a prototype.
 * `collab-try-later-parity.test.ts` reads the server union and holds the partition to it: a new server rule goes red
 * until it joins exactly one cause here.
 */
export type CollabRefusalCause = "change" | "copy" | "other";

export const COLLAB_REFUSAL_RULES: Readonly<
  Record<CollabRefusalCause, ReadonlySet<string>>
> = {
  change: new Set([
    "schema",
    "string-attr",
    "number-attr",
    "table-size",
    "element-depth",
    "value-depth",
    "value-size",
    "value-kind",
    "unknown-mark",
    "hashed-mark",
    "attr-kind",
    "text-kind",
    "child-kind",
    "content-kind",
    "zero-length",
    "conflict-scan",
    "delete-order",
    // #827: a change this browser holds that the page cannot take (the notice's Discard-first kinds say which)
    "frame-too-large",
    "apply-deadline",
    "page-full",
  ]),
  copy: new Set(["root", "foreign-client", "client-ids", "unresolved"]),
  other: new Set([
    "internal",
    "shadow-unavailable",
    "stateless",
    "auth",
    "message-type",
    "awareness",
    "undecodable",
    "cross-list",
  ]),
};

export function collabRefusalCause(
  rule: string | null | undefined,
): CollabRefusalCause {
  if (typeof rule !== "string") return "other";
  if (COLLAB_REFUSAL_RULES.change.has(rule)) return "change";
  if (COLLAB_REFUSAL_RULES.copy.has(rule)) return "copy";
  return "other";
}
