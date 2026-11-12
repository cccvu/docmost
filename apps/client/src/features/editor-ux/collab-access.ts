import { jwtDecode } from "jwt-decode";
import { COLLAB_LOCAL_COPY_RULE } from "./collab-refusal-cause";

/**
 * CCC fork addition (cccvu/wiki-v2#501) — how an open editor reacts when the server narrows its collab access.
 *
 * The fork's live-access revalidator closes a collab connection whose user lost access (restricted, removed,
 * demoted to reader). Hocuspocus closes it PER DOCUMENT: the server sends a CLOSE message and the websocket
 * stays open, so upstream's editor noticed nothing — no status, still editable, and everything typed afterwards
 * was silently held back. These rules turn that into a visible, correct state:
 *
 *   - a server-side close while the socket is still connected → reconnect now, so the server re-decides
 *     (a demoted user comes back read-only; a user who lost access is refused);
 *   - an authentication refusal that is NOT an expired token → refetch the collab token ONCE and retry (#537:
 *     the token is bound to the session that minted it, so a refusal can mean that session ended while a newer
 *     one is live, e.g. the user signed in again); a second refusal with no successful authentication in
 *     between, or a refetch that fails, means access is lost: stop editing and show the connection-lost
 *     status. An expired token refetches every time, as upstream did; a refetch that fails is lost there too
 *     (upstream left that editor editable with nothing syncing). #790: a lost editor also closes its socket and
 *     opens it again after COLLAB_LOST_RETRY_MS, or when the tab becomes visible again, never at the provider's pace;
 *   - a successful authentication → the server's scope decides whether the editor may edit;
 *   - #781: the server's collab ingress guard refuses a frame it will not apply with that same per-document CLOSE,
 *     and the provider reports it as code 1000, so the REASON is the only signal:
 *       - `ccc:collab-update-refused:<rule>` → detach the provider (a refused provider stays attached and keeps
 *         sending), stop editing, show the refusal notice, and never reconnect: this browser's copy would be
 *         replayed and refused again. Final until the page reloads. #790: close the editor's socket too (each page
 *         editor has its own); with nothing attached it would otherwise idle, or reconnect every 30 s (the
 *         provider's message timeout), for as long as the tab stays open. Reload and Discard reload the page, so
 *         they need no socket. The `<rule>` is kept (`refusedRule`) and picks the notice's copy
 *         (`collab-refusal-cause.ts`): a stored copy the server disagrees with is not "your changes were not saved";
 *       - `ccc:collab-update-unresolved` → the server could not decide; reconnect ONCE. The retry is spent until
 *         `sync-acked` (every frame this provider sent was applied), NOT until the next authentication, which
 *         happens before the replay is judged; a second one before that is treated as refused.
 *   - #790: a SOCKET close with code 1009 (the server's ws "message too big": this browser sent a frame over the
 *     server's maxPayload) is refused too. The provider would reconnect and resend the same frame (its Step2 answer
 *     to the server's Step1) every second, forever. Only a raw socket close carries a code other than 1000.
 *     #810: the notice then leads with Discard (`refusalKind` too-big): a reload replays the same oversized copy;
 *   - #810: "try later" (the server's per-user auth rate, its per-user connection cap, its per-(user, document)
 *     budgets, and a draining node all say so, see TRY_LATER_*) → close the socket, show the disconnected status, and
 *     open it again after a jittered, growing wait (5 s doubling to COLLAB_LOST_RETRY_MS, `collabRetryDelay`). Never
 *     the #537 token refetch (a rate-limited refusal says nothing about the token) and never lost: the editor stays
 *     editable, as offline, and its edits wait in the Y doc. The provider's own reconnect after any received frame
 *     is a FIXED 1 s with no backoff, so leaving these to the provider re-sent each refused attempt every second.
 *   - #810: every token refetch also closes the socket first. The server closes a refused socket (4401) right after
 *     its refusal, and the provider would reconnect it in 1 s with the OLD token, racing the refetch.
 *   - #827: the page's lineage moved on (`ccc:collab-update-refused:epoch-stale:<N>`: the server compacted it, so this
 *     copy can never merge) → detach and stop, like a refusal, and hand N to the page (`epochChangedTo`): a clean copy
 *     switches to epoch N, a dirty one shows the Discard-first "compacted" notice (collab-epoch.ts). Checked before the
 *     generic refused prefix, which it shares on purpose (a pre-#827 editor reads it as a refusal and Reload loads the
 *     new bundle). An N equal to this copy's own epoch is an ordinary refusal: switching to it would loop;
 *   - #827: the page is being compacted (`ccc:collab-page-compacting`, a close or an auth refusal) → read-only (an edit
 *     made now would be in the old lineage and end in Discard), a banner, and a retry 2 s doubling to
 *     COLLAB_LOST_RETRY_MS. A socket's load refused while its user is in CPU debt (`ccc:collab-load-try-later`) is an
 *     ordinary try later. Both are pace hints that grant nothing, never the #537 refetch;
 *   - #827: the try-later backoff resets on `synced` (the server's Step2 applied), not on `authenticated`: a load that
 *     trips is refused AFTER the authentication, so resetting there kept the wait at 5 s forever;
 *   - #827: the update guard's new rules are Discard-first (`refusalKind`): `frame-too-large` (as a 1009), the
 *     `apply-deadline` strike ("too complex") and `page-full`. A reload would replay the same copy.
 *   - #847: this browser's own Yjs copy broke (`local-copy-broken`, from `collab-copy-health.ts`: a wedged document
 *     that will never send or persist again, or a stored copy whose replay threw) → refused, like a server refusal:
 *     detach, close the socket, read-only, so the broken copy stops sending and persisting. The rule is the client's
 *     own `COLLAB_LOCAL_COPY_RULE`, whose notice says the stored copy does not match and offers Reload and Discard.
 *     Never discarded automatically: the dirty marker cannot vouch for a broken copy.
 *
 * Pure and dependency-free so it is unit-tested without a provider; `collab-access-controller.ts` carries out its
 * steps and page-editor.tsx wires the controller (seam 169).
 */

export interface CollabAccessState {
  /** The server refused this document (not a token expiry). */
  lost: boolean;
  /** The server authenticated the connection read-only. */
  readOnly: boolean;
  /** A non-expiry refusal already refetched the token; the next one is final (reset by `authenticated`). */
  refreshed: boolean;
  /** #781: the server refused a frame from this editor; the provider is detached. Final until a reload. */
  refused: boolean;
  /** #781: an `unresolved` close already reconnected; the next one is refused (reset only by `sync-acked`). */
  unresolvedRetried: boolean;
  /** #810, #827: which refusal notice: the Discard-first kinds say a reload would replay the same copy. */
  refusalKind: CollabRefusalKind;
  /**
   * The rule the server refused on (`ccc:collab-update-refused:<rule>`), or `"unresolved"` for a second unresolved;
   * null otherwise (not refused, a 1009, or a reason without the prefix). Picks a generic notice's copy
   * (`collab-refusal-cause.ts`): it is a server-sent string, so it is only ever looked up, never rendered.
   */
  refusedRule: string | null;
  /** #810: "try later" answers since the last completed sync (#827: the retry wait grows with it). */
  tryLaterAttempts: number;
  /** #827: the server is compacting the page: read-only, retrying, until the next completed sync. */
  compacting: boolean;
  /** #827: the page's lineage is now this epoch (the server compacted it); this copy is detached. */
  epochChangedTo: number | null;
}

/**
 * #810, #827: what the refusal notice says. `generic` offers Reload first; every other kind is Discard-first:
 *   - too-big: a 1009, or `frame-too-large` (a frame over the page's size cap);
 *   - too-complex: `apply-deadline` (a frame the server ran out of time applying, twice);
 *   - page-full: `page-full` (the page is at its structure limit even after compaction);
 *   - compacted: an epoch-stale refusal of a copy with unsaved changes (a clean copy switches instead).
 */
export type CollabRefusalKind =
  | "generic"
  | "too-big"
  | "too-complex"
  | "page-full"
  | "compacted";

export const initialCollabAccess: CollabAccessState = {
  lost: false,
  readOnly: false,
  refreshed: false,
  refused: false,
  unresolvedRetried: false,
  refusalKind: "generic",
  refusedRule: null,
  tryLaterAttempts: 0,
  compacting: false,
  epochChangedTo: null,
};

/** #781: the server's close reasons (`apps/server/src/authz/collab-ingress`). */
export const COLLAB_UPDATE_REFUSED_PREFIX = "ccc:collab-update-refused:";
export const COLLAB_UPDATE_UNRESOLVED = "ccc:collab-update-unresolved";

/** #790: the ws close code for a message over the server's `maxPayload` (RFC 6455 "Message Too Big"). */
export const WS_CLOSE_MESSAGE_TOO_BIG = 1009;

/**
 * #827: the server's reasons (`apps/server/src/authz/collab-ingress/collab-reasons.ts`; the parity test holds them
 * equal). The epoch-stale prefix extends COLLAB_UPDATE_REFUSED_PREFIX, so it is matched first.
 */
export const COLLAB_EPOCH_STALE_PREFIX = "ccc:collab-update-refused:epoch-stale:";
export const COLLAB_PAGE_COMPACTING_REASON = "ccc:collab-page-compacting";
export const COLLAB_LOAD_TRY_LATER_REASON = "ccc:collab-load-try-later";
/** #827: the update guard's Discard-first rules (`ccc:collab-update-refused:<rule>`). */
export const COLLAB_RULE_FRAME_TOO_LARGE = "frame-too-large";
export const COLLAB_RULE_APPLY_DEADLINE = "apply-deadline";
export const COLLAB_RULE_PAGE_FULL = "page-full";

/** #827: an epoch as the server writes it (no sign, no leading zero, a safe integer); the parity test pins it. */
export const COLLAB_EPOCH_PATTERN = /^(0|[1-9][0-9]{0,14})$/;

/** #827: the epoch an epoch-stale reason names, or null for any other (or a malformed) reason. */
export function parseEpochStaleReason(reason: string | undefined): number | null {
  if (typeof reason !== "string" || !reason.startsWith(COLLAB_EPOCH_STALE_PREFIX)) {
    return null;
  }
  const tail = reason.slice(COLLAB_EPOCH_STALE_PREFIX.length);
  return COLLAB_EPOCH_PATTERN.test(tail) ? Number(tail) : null;
}

/** #810, #827: the notice a refusal gets, from its close code and reason. */
export function collabRefusalKind(
  reason: string | undefined,
  code?: number,
): CollabRefusalKind {
  if (code === WS_CLOSE_MESSAGE_TOO_BIG) return "too-big";
  switch (
    typeof reason === "string" && reason.startsWith(COLLAB_UPDATE_REFUSED_PREFIX)
      ? reason.slice(COLLAB_UPDATE_REFUSED_PREFIX.length)
      : undefined
  ) {
    case COLLAB_RULE_FRAME_TOO_LARGE:
      return "too-big";
    case COLLAB_RULE_APPLY_DEADLINE:
      return "too-complex";
    case COLLAB_RULE_PAGE_FULL:
      return "page-full";
    default:
      return "generic";
  }
}

/**
 * #810: the server's "try later" signals, copied from `apps/server/src/authz/collab-ingress` (the parity test
 * `collab-try-later-parity.test.ts` reads the server source and holds these equal). A reason is only a pace hint: it
 * grants nothing, and the next attempt meets the server's full access check.
 *   - authentication refused for the per-user auth rate, or the per-user connection cap;
 *   - a socket closed 1013 (RFC 6455 Try Again Later: a per-(user, document) budget, or a draining node) or 4429 (the
 *     per-user connection cap), and a document CLOSE that names one of those reasons.
 */
export const TRY_LATER_AUTH_REASONS: readonly string[] = [
  "ccc:collab-auth-rate-limited",
  "ccc:collab-user-connections",
  COLLAB_LOAD_TRY_LATER_REASON, // #827: a socket's load refused while its user is in CPU debt
];
export const TRY_LATER_CLOSE_REASONS: readonly string[] = [
  "ccc:collab-try-later",
  "ccc:collab-user-connections",
  COLLAB_LOAD_TRY_LATER_REASON,
];
export const TRY_LATER_CLOSE_CODES: readonly number[] = [1013, 4429];

/** The rule a refusal names (`ccc:collab-update-refused:<rule>`), or null for any other reason. */
export function refusedRuleOf(reason: string | undefined): string | null {
  return typeof reason === "string" &&
    reason.startsWith(COLLAB_UPDATE_REFUSED_PREFIX)
    ? reason.slice(COLLAB_UPDATE_REFUSED_PREFIX.length)
    : null;
}

export function classifyCollabCloseReason(
  reason: string | undefined,
  code?: number,
): "refused" | "epoch" | "unresolved" | "compacting" | "try-later" | "other" {
  if (code === WS_CLOSE_MESSAGE_TOO_BIG) return "refused";
  if (typeof reason === "string") {
    // #827: before the refused prefix it extends (a malformed epoch is still "epoch": nextCollabAccess refuses it)
    if (reason.startsWith(COLLAB_EPOCH_STALE_PREFIX)) return "epoch";
    if (reason.startsWith(COLLAB_UPDATE_REFUSED_PREFIX)) return "refused";
    if (reason === COLLAB_UPDATE_UNRESOLVED) return "unresolved";
    // #827: before the 1013 code fallback, which it is sent with
    if (reason === COLLAB_PAGE_COMPACTING_REASON) return "compacting";
    if (TRY_LATER_CLOSE_REASONS.includes(reason)) return "try-later";
  }
  if (typeof code === "number" && TRY_LATER_CLOSE_CODES.includes(code)) {
    return "try-later";
  }
  return "other";
}

export type CollabAccessEvent =
  | {
      kind: "server-close";
      socketConnected: boolean;
      reason?: string;
      /** #790: the close code (a document CLOSE is always 1000; a raw socket close carries the socket's own). */
      code?: number;
    }
  | {
      kind: "auth-failed";
      tokenExpired: boolean;
      /** #810: the server's refusal reason (the provider's `onAuthenticationFailed({ reason })`). */
      reason?: string;
    }
  | { kind: "refresh-failed" }
  | { kind: "authenticated"; scope: string | undefined }
  /** #781: the provider's unsynced-changes count reached 0 — the server applied every frame it was sent. */
  | { kind: "sync-acked" }
  /** #827: the provider synced (the server's Step2 applied): the page loaded, so stop waiting. */
  | { kind: "synced" }
  /** #847: this browser's Yjs copy broke (`collab-copy-health.ts`): it can no longer be trusted to send or persist. */
  | { kind: "local-copy-broken" };

export interface CollabAccessStep {
  state: CollabAccessState;
  /** Re-open the socket so every attached document re-authenticates. */
  reconnect: boolean;
  /** Refetch the collab token, then reconnect with it (report a failure as `refresh-failed`). */
  refreshToken: boolean;
  /** Show the connection-lost status (the editor can no longer sync this document). */
  markDisconnected: boolean;
  /** #781: detach the provider so it stops sending (and keep it detached). */
  detach: boolean;
  /** #790: close the editor's socket (after a refusal, for good; after a loss, until `retryAfterMs`). */
  disconnectSocket: boolean;
  /** #790: lost, #810: try later: open the socket again after about this many ms (0: no timer; jittered by the caller). */
  retryAfterMs: number;
}

/**
 * #790: how long a lost editor waits before it opens its socket again (the tab becoming visible again also reopens it,
 * page-editor.tsx). The server closes a socket right after refusing its authentication and counts every unauthenticated
 * socket against a process-wide pool, so a lost editor that kept reconnecting at the provider's pace (about once a
 * second) would hold a slot of that pool for as long as the tab stayed open.
 */
export const COLLAB_LOST_RETRY_MS = 60_000;

/** #810: the first "try later" wait; it doubles with each further one, up to COLLAB_LOST_RETRY_MS. */
export const COLLAB_TRY_LATER_BASE_MS = 5_000;

/** #810: no jittered retry waits less than this. */
export const COLLAB_RETRY_MIN_MS = 1_000;

/** #827: the first wait after a "compacting" answer (a compaction takes seconds); it doubles like a try later. */
export const COLLAB_COMPACTING_BASE_MS = 2_000;

/**
 * #810: the wait the caller actually uses for a step's `retryAfterMs`: between half of it and all of it, so the
 * editors a deploy or an outage disconnected together do not come back together.
 */
export function collabRetryDelay(
  ms: number,
  random: () => number = Math.random,
): number {
  const r = Math.min(1, Math.max(0, random()));
  return Math.max(COLLAB_RETRY_MIN_MS, Math.round(ms * (0.5 + 0.5 * r)));
}

/** #810: a retry timer still has work: the editor is lost, or waiting after a "try later". */
export function collabAwaitsRetry(state: CollabAccessState): boolean {
  return !state.refused && (state.lost || state.tryLaterAttempts > 0);
}

const NO_ACTION = {
  reconnect: false,
  refreshToken: false,
  markDisconnected: false,
  detach: false,
  disconnectSocket: false,
  retryAfterMs: 0,
} as const;

/**
 * `clientEpoch` (#827) is the lineage this editor's copy and socket claim (`?cccEpoch`, collab-epoch.ts).
 */
export function nextCollabAccess(
  prev: CollabAccessState,
  event: CollabAccessEvent,
  clientEpoch = 0,
): CollabAccessStep {
  // #781: refused is final. The provider is detached, so nothing should arrive; if something does, ignore it.
  if (prev.refused) return { state: prev, ...NO_ACTION };
  switch (event.kind) {
    case "server-close": {
      const reason = classifyCollabCloseReason(event.reason, event.code);
      if (reason === "epoch") return epochStep(prev, event.reason, clientEpoch);
      if (reason === "refused") {
        const tooBig = event.code === WS_CLOSE_MESSAGE_TOO_BIG;
        return refusedStep(prev, collabRefusalKind(event.reason, event.code), tooBig ? null : refusedRuleOf(event.reason));
      }
      if (reason === "compacting") return compactingStep(prev);
      if (reason === "try-later") return tryLaterStep(prev);
      if (reason === "unresolved") {
        if (prev.unresolvedRetried) return refusedStep(prev, "generic", "unresolved");
        // Reconnect once (a closing socket is reconnected by the provider itself).
        return {
          ...NO_ACTION,
          state: { ...prev, unresolvedRetried: true },
          reconnect: event.socketConnected,
        };
      }
      // A raw socket close is already handled by the provider (it reconnects and re-authenticates). Only a
      // per-document CLOSE on a live socket leaves the document unauthenticated with nothing to recover it.
      return { ...NO_ACTION, state: prev, reconnect: event.socketConnected };
    }
    case "sync-acked":
      if (!prev.unresolvedRetried) return { state: prev, ...NO_ACTION };
      return { state: { ...prev, unresolvedRetried: false }, ...NO_ACTION };
    case "synced":
      // #827: the server loaded the page and answered: the wait (and a compaction) is over. Same object when there
      // is nothing to clear, so a sync does not re-render.
      if (!prev.compacting && prev.tryLaterAttempts === 0) {
        return { state: prev, ...NO_ACTION };
      }
      return {
        state: { ...prev, compacting: false, tryLaterAttempts: 0 },
        ...NO_ACTION,
      };
    case "auth-failed":
      // #827: a load refused for a stale lineage or a compaction, before the #537 path (the token verified).
      if (parseEpochStaleReason(event.reason) !== null) {
        return epochStep(prev, event.reason, clientEpoch);
      }
      if (event.reason === COLLAB_PAGE_COMPACTING_REASON) {
        return compactingStep(prev);
      }
      // #810: checked first: a rate-limited refusal implies the token verified, so a refetch would not help.
      if (
        typeof event.reason === "string" &&
        TRY_LATER_AUTH_REASONS.includes(event.reason)
      ) {
        return tryLaterStep(prev);
      }
      // #810 (review R4-F3): every refetch closes the socket first. The server closes a refused socket (4401), and
      // the provider would reconnect it in 1 s with the OLD token; the refetch reopens it with the new one.
      if (event.tokenExpired) {
        return {
          ...NO_ACTION,
          state: prev,
          refreshToken: true,
          disconnectSocket: true,
        };
      }
      if (!prev.refreshed) {
        return {
          ...NO_ACTION,
          state: { ...prev, refreshed: true },
          refreshToken: true,
          disconnectSocket: true,
        };
      }
      return lostStep(prev);
    case "refresh-failed":
      return lostStep(prev);
    case "local-copy-broken":
      // #847: as a refusal (the `refused` guard above keeps it to one): stop sending, stop editing, never reconnect
      return refusedStep(prev, "generic", COLLAB_LOCAL_COPY_RULE);
    case "authenticated":
      return {
        ...NO_ACTION,
        state: {
          ...prev, // #781: `unresolvedRetried` survives: authenticating says nothing about the replay
          lost: false,
          readOnly: event.scope === "readonly",
          refreshed: false,
          // #827: `tryLaterAttempts` survives: a load that trips is refused after the authentication (`synced` resets it)
        },
      };
  }
}

/** Access lost: show the connection-lost status, close the socket, and try again in COLLAB_LOST_RETRY_MS (#790). */
function lostStep(prev: CollabAccessState): CollabAccessStep {
  return {
    ...NO_ACTION,
    state: { ...prev, lost: true },
    markDisconnected: true,
    disconnectSocket: true,
    retryAfterMs: COLLAB_LOST_RETRY_MS,
  };
}

/**
 * #810: the server asked this editor to try later. Close the socket and open it again after a wait that doubles with
 * each answer like it (5 s, 10 s, ... COLLAB_LOST_RETRY_MS), until a completed sync resets it (#827). Not lost, not
 * refused, no token refetch, still editable (edits wait in the Y doc, as offline); `refreshed` is untouched.
 */
function tryLaterStep(prev: CollabAccessState): CollabAccessStep {
  const retryAfterMs = Math.min(
    COLLAB_LOST_RETRY_MS,
    COLLAB_TRY_LATER_BASE_MS * 2 ** Math.min(prev.tryLaterAttempts, 16),
  );
  return {
    ...NO_ACTION,
    state: { ...prev, tryLaterAttempts: prev.tryLaterAttempts + 1 },
    markDisconnected: true,
    disconnectSocket: true,
    retryAfterMs,
  };
}

/**
 * #827: the server is compacting the page. As a try later (close the socket, no refetch, never lost), but read-only
 * and from COLLAB_COMPACTING_BASE_MS: the page comes back in seconds, under a new epoch.
 */
function compactingStep(prev: CollabAccessState): CollabAccessStep {
  const retryAfterMs = Math.min(
    COLLAB_LOST_RETRY_MS,
    COLLAB_COMPACTING_BASE_MS * 2 ** Math.min(prev.tryLaterAttempts, 16),
  );
  return {
    ...NO_ACTION,
    state: {
      ...prev,
      compacting: true,
      tryLaterAttempts: prev.tryLaterAttempts + 1,
    },
    markDisconnected: true,
    disconnectSocket: true,
    retryAfterMs,
  };
}

/**
 * #827: the server refused this copy's lineage. Detach and close for good, like a refusal (nothing of either lineage
 * may merge into the other), and name the new epoch for the page to switch to. An epoch that cannot be read, or the
 * one this copy already claims, is an ordinary refusal: switching to it would reconnect into the same answer.
 */
function epochStep(
  prev: CollabAccessState,
  reason: string | undefined,
  clientEpoch: number,
): CollabAccessStep {
  const epoch = parseEpochStaleReason(reason);
  if (epoch === null || epoch === clientEpoch) return refusedStep(prev, "generic", refusedRuleOf(reason));
  const step = refusedStep(prev, "compacted", refusedRuleOf(reason));
  return { ...step, state: { ...step.state, epochChangedTo: epoch } };
}

/**
 * #781: stop sending and stop editing. No `markDisconnected`: the header's "connection lost. Retrying..." would be
 * untrue (nothing retries); the refusal notice says what happened and offers the recovery. Not marking it is not
 * enough on its own: a raw socket close reaches the header before this step, and page-editor's 7.5 s "not synced"
 * check would mark it after, so page-editor also passes the header status through `collabHeaderStatus`
 * (`collab-header-status.ts`). #810, #827: `kind` tells the notice whether only discarding this browser's copy
 * recovers; `rule` picks a generic notice's copy (`collab-refusal-cause.ts`).
 */
function refusedStep(
  prev: CollabAccessState,
  kind: CollabRefusalKind,
  rule: string | null,
): CollabAccessStep {
  return {
    ...NO_ACTION,
    state: { ...prev, refused: true, refusalKind: kind, refusedRule: rule, compacting: false },
    detach: true,
    disconnectSocket: true,
  };
}

/** The editor may edit only if the page allows it AND the server still lets this connection write. */
export function collabAllowsEditing(state: CollabAccessState): boolean {
  return (
    !state.lost && !state.readOnly && !state.refused && !state.compacting
  );
}

/**
 * The collab token the provider will send on its next authentication. A refresh writes the new token to
 * `remote.configuration.token`; the value captured when the editor mounted goes stale after the first refresh,
 * and deciding "expired?" from it misreads every later refusal as an expiry (refetch → reconnect → refused,
 * forever, never reaching the lost state).
 */
export function currentCollabToken(
  configured: unknown,
  initial: string | undefined,
): string | undefined {
  return typeof configured === "string" && configured ? configured : initial;
}

/** Expired (or unreadable/missing — refresh it rather than declare access lost). */
export function isCollabTokenExpired(
  token: string | undefined,
  nowMs: number,
): boolean {
  if (!token) return true;
  try {
    const { exp } = jwtDecode(token);
    return typeof exp !== "number" || nowMs / 1000 >= exp;
  } catch {
    return true;
  }
}
