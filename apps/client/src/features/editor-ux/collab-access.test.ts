import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COLLAB_LOST_RETRY_MS,
  COLLAB_RETRY_MIN_MS,
  COLLAB_TRY_LATER_BASE_MS,
  COLLAB_UPDATE_REFUSED_PREFIX,
  COLLAB_UPDATE_UNRESOLVED,
  CollabAccessEvent,
  CollabAccessState,
  classifyCollabCloseReason,
  collabAllowsEditing,
  collabAwaitsRetry,
  collabRetryDelay,
  currentCollabToken,
  initialCollabAccess,
  isCollabTokenExpired,
  nextCollabAccess,
  WS_CLOSE_MESSAGE_TOO_BIG,
} from "./collab-access";

/** An unsigned JWT with the given exp (seconds). jwt-decode only decodes. */
const jwt = (exp: number) =>
  `e30.${btoa(JSON.stringify({ exp })).replace(/=+$/, "")}.sig`;

// cccvu/wiki-v2#501 — an open editor must react when the server narrows its collab access.
describe("nextCollabAccess", () => {
  it("a per-document server close on a live socket reconnects so the server re-decides", () => {
    const step = nextCollabAccess(initialCollabAccess, {
      kind: "server-close",
      socketConnected: true,
    });
    expect(step.reconnect).toBe(true);
    expect(step.markDisconnected).toBe(false);
    expect(collabAllowsEditing(step.state)).toBe(true); // not decided yet
  });

  it("a raw socket close is left to the provider (it already reconnects)", () => {
    const step = nextCollabAccess(initialCollabAccess, {
      kind: "server-close",
      socketConnected: false,
    });
    expect(step.reconnect).toBe(false);
  });

  // #537: the collab token is bound to the session that minted it, so the FIRST refusal refetches it once.
  it("the first refusal that is not a token expiry refetches the token once and is NOT lost", () => {
    const step = nextCollabAccess(initialCollabAccess, {
      kind: "auth-failed",
      tokenExpired: false,
    });
    expect(step.refreshToken).toBe(true);
    expect(step.state.lost).toBe(false);
    expect(step.state.refreshed).toBe(true);
    expect(step.markDisconnected).toBe(false);
    expect(collabAllowsEditing(step.state)).toBe(true); // not decided yet
  });

  it("a refusal after that refetch (no authentication in between) means access is lost: stop editing, show the lost status", () => {
    const first = nextCollabAccess(initialCollabAccess, {
      kind: "auth-failed",
      tokenExpired: false,
    });
    const second = nextCollabAccess(first.state, {
      kind: "auth-failed",
      tokenExpired: false,
    });
    expect(second.refreshToken).toBe(false); // no loop
    expect(second.state.lost).toBe(true);
    expect(second.markDisconnected).toBe(true);
    expect(collabAllowsEditing(second.state)).toBe(false);
    // and it stays final: a further refusal never refetches again
    const third = nextCollabAccess(second.state, {
      kind: "auth-failed",
      tokenExpired: false,
    });
    expect(third.refreshToken).toBe(false);
    expect(third.state.lost).toBe(true);
  });

  it("a successful authentication resets the refetch, so a later refusal refetches once again", () => {
    const first = nextCollabAccess(initialCollabAccess, {
      kind: "auth-failed",
      tokenExpired: false,
    });
    const ok = nextCollabAccess(first.state, {
      kind: "authenticated",
      scope: "read-write",
    });
    expect(ok.state).toEqual(initialCollabAccess);
    const later = nextCollabAccess(ok.state, {
      kind: "auth-failed",
      tokenExpired: false,
    });
    expect(later.refreshToken).toBe(true);
    expect(later.state.lost).toBe(false);
  });

  it("a failed refetch means access is lost", () => {
    const first = nextCollabAccess(initialCollabAccess, {
      kind: "auth-failed",
      tokenExpired: false,
    });
    const failed = nextCollabAccess(first.state, { kind: "refresh-failed" });
    expect(failed.refreshToken).toBe(false);
    expect(failed.state.lost).toBe(true);
    expect(failed.markDisconnected).toBe(true);
    expect(collabAllowsEditing(failed.state)).toBe(false);
  });

  it("an expired token refetches every time and is not lost by the refusal itself", () => {
    const step = nextCollabAccess(initialCollabAccess, {
      kind: "auth-failed",
      tokenExpired: true,
    });
    expect(step.refreshToken).toBe(true);
    expect(step.state).toEqual(initialCollabAccess);
    expect(step.markDisconnected).toBe(false);
    // an expiry after a non-expiry refetch still refreshes and does not use up or end the state
    const afterRefetch = nextCollabAccess(
      { ...initialCollabAccess, refreshed: true },
      { kind: "auth-failed", tokenExpired: true },
    );
    expect(afterRefetch.refreshToken).toBe(true);
    expect(afterRefetch.state.lost).toBe(false);
  });

  it("a failed refetch after an expiry is lost too (upstream left the editor editable, syncing nothing)", () => {
    const expired = nextCollabAccess(initialCollabAccess, {
      kind: "auth-failed",
      tokenExpired: true,
    });
    const failed = nextCollabAccess(expired.state, { kind: "refresh-failed" });
    expect(failed.state.lost).toBe(true);
    expect(failed.markDisconnected).toBe(true);
    expect(collabAllowsEditing(failed.state)).toBe(false);
    // and a successful authentication (e.g. the provider's own reconnect) clears it
    const ok = nextCollabAccess(failed.state, {
      kind: "authenticated",
      scope: "read-write",
    });
    expect(collabAllowsEditing(ok.state)).toBe(true);
  });

  it("a demoted user re-authenticates read-only and can no longer edit", () => {
    const step = nextCollabAccess(initialCollabAccess, {
      kind: "authenticated",
      scope: "readonly",
    });
    expect(step.state).toEqual({
      ...initialCollabAccess,
      readOnly: true,
    });
    expect(collabAllowsEditing(step.state)).toBe(false);
  });

  it("a read-write authentication (e.g. access restored) clears lost and read-only", () => {
    const step = nextCollabAccess(
      { ...initialCollabAccess, lost: true, readOnly: true, refreshed: true },
      { kind: "authenticated", scope: "read-write" },
    );
    expect(step.state).toEqual(initialCollabAccess);
    expect(collabAllowsEditing(step.state)).toBe(true);
  });
});

// cccvu/wiki-v2#781 — the server refuses a collab frame it will not apply with a document-level CLOSE (the socket
// stays open, and the provider reports code 1000 for it), so the reason string is the only signal.
describe("collab update refusal (#781)", () => {
  const refused = (rule: string) => `${COLLAB_UPDATE_REFUSED_PREFIX}${rule}`;
  const close = (reason: string | undefined, socketConnected = true) =>
    ({ kind: "server-close", socketConnected, reason }) as const;
  const allEvents = [
    close(undefined),
    close(undefined, false),
    close(refused("mark")),
    close(COLLAB_UPDATE_UNRESOLVED),
    { kind: "auth-failed", tokenExpired: false },
    { kind: "auth-failed", tokenExpired: true },
    { kind: "refresh-failed" },
    { kind: "authenticated", scope: "read-write" },
    { kind: "authenticated", scope: "readonly" },
    { kind: "sync-acked" },
  ] as const;

  it("classifies only the two contract reasons; anything else is an ordinary close", () => {
    expect(classifyCollabCloseReason(refused("root"))).toBe("refused");
    expect(classifyCollabCloseReason(refused("shadow-unavailable"))).toBe(
      "refused",
    );
    expect(classifyCollabCloseReason(COLLAB_UPDATE_UNRESOLVED)).toBe(
      "unresolved",
    );
    for (const other of [
      undefined,
      "",
      "Forbidden",
      "ccc:collab-update-refused", // no rule separator: not the contract
      "ccc:collab-update-unresolved:x",
      "xccc:collab-update-refused:mark",
      ` ${COLLAB_UPDATE_UNRESOLVED}`,
    ]) {
      expect(classifyCollabCloseReason(other)).toBe("other");
    }
  });

  it.each([
    "root",
    "mark",
    "schema",
    "foreign-client",
    "value-depth",
    "shadow-unavailable",
  ])(
    "refused:%s ⇒ detach the provider, stop editing, never reconnect or refetch",
    (rule) => {
      const step = nextCollabAccess(initialCollabAccess, close(refused(rule)));
      expect(step.detach).toBe(true);
      expect(step.disconnectSocket).toBe(true); // #790: the editor's now-empty socket closes too
      expect(step.reconnect).toBe(false);
      expect(step.refreshToken).toBe(false);
      expect(step.state.refused).toBe(true);
      expect(collabAllowsEditing(step.state)).toBe(false);
      // The notice is the UX: the header's "connection lost. Retrying..." indicator would be untrue (nothing retries).
      expect(step.markDisconnected).toBe(false);
    },
  );

  it("refused on a socket that is already closing still detaches (the socket's own reconnect would re-sync it)", () => {
    const step = nextCollabAccess(
      initialCollabAccess,
      close(refused("mark"), false),
    );
    expect(step.detach).toBe(true);
    expect(step.disconnectSocket).toBe(true); // #790: and stays closed (the socket's own retry stops)
    expect(step.reconnect).toBe(false);
    expect(step.state.refused).toBe(true);
  });

  it("refused is final: no later event reconnects, refetches, re-allows editing or changes the state", () => {
    const refusedState = nextCollabAccess(
      initialCollabAccess,
      close(refused("mark")),
    ).state;
    for (const event of allEvents) {
      const step = nextCollabAccess(refusedState, event);
      expect(step.state).toBe(refusedState);
      expect(step.reconnect).toBe(false);
      expect(step.refreshToken).toBe(false);
      expect(step.detach).toBe(false); // already detached
      expect(step.disconnectSocket).toBe(false); // already closed
      expect(step.markDisconnected).toBe(false);
      expect(collabAllowsEditing(step.state)).toBe(false);
    }
  });

  it("the first unresolved reconnects once, keeps editing, and does not detach", () => {
    const step = nextCollabAccess(
      initialCollabAccess,
      close(COLLAB_UPDATE_UNRESOLVED),
    );
    expect(step.reconnect).toBe(true);
    expect(step.detach).toBe(false);
    expect(step.refreshToken).toBe(false);
    expect(step.markDisconnected).toBe(false);
    expect(step.state.unresolvedRetried).toBe(true);
    expect(step.state.refused).toBe(false);
    expect(collabAllowsEditing(step.state)).toBe(true);
  });

  it("the first unresolved on a closing socket leaves the reconnect to the provider but still spends the retry", () => {
    const step = nextCollabAccess(
      initialCollabAccess,
      close(COLLAB_UPDATE_UNRESOLVED, false),
    );
    expect(step.reconnect).toBe(false);
    expect(step.state.unresolvedRetried).toBe(true);
    const second = nextCollabAccess(
      step.state,
      close(COLLAB_UPDATE_UNRESOLVED),
    );
    expect(second.state.refused).toBe(true);
    expect(second.detach).toBe(true);
  });

  it("a second unresolved with no sync-acked in between is refused, even across a re-authentication", () => {
    let state: CollabAccessState = nextCollabAccess(
      initialCollabAccess,
      close(COLLAB_UPDATE_UNRESOLVED),
    ).state;
    // the reconnect re-authenticates (and may even refetch the token first): neither is proof the replay landed
    for (const event of [
      { kind: "auth-failed", tokenExpired: true },
      { kind: "authenticated", scope: "read-write" },
      { kind: "authenticated", scope: "readonly" },
      { kind: "authenticated", scope: "read-write" },
      close(undefined),
    ] as const) {
      state = nextCollabAccess(state, event).state;
      expect(state.unresolvedRetried).toBe(true);
    }
    const second = nextCollabAccess(state, close(COLLAB_UPDATE_UNRESOLVED));
    expect(second.reconnect).toBe(false);
    expect(second.detach).toBe(true);
    expect(second.state.refused).toBe(true);
    expect(collabAllowsEditing(second.state)).toBe(false);
  });

  it("sync-acked (every sent frame applied) clears the retry, so a later unresolved reconnects once again", () => {
    const first = nextCollabAccess(
      initialCollabAccess,
      close(COLLAB_UPDATE_UNRESOLVED),
    );
    const authed = nextCollabAccess(first.state, {
      kind: "authenticated",
      scope: "read-write",
    });
    const acked = nextCollabAccess(authed.state, { kind: "sync-acked" });
    expect(acked.state.unresolvedRetried).toBe(false);
    expect(acked.reconnect || acked.refreshToken || acked.detach).toBe(false);
    const later = nextCollabAccess(
      acked.state,
      close(COLLAB_UPDATE_UNRESOLVED),
    );
    expect(later.reconnect).toBe(true);
    expect(later.state.refused).toBe(false);
    expect(later.state.unresolvedRetried).toBe(true);
  });

  it("sync-acked with no retry pending is a no-op that keeps the same state object (no re-render per ack)", () => {
    const state = { ...initialCollabAccess, readOnly: true, refreshed: true };
    const step = nextCollabAccess(state, { kind: "sync-acked" });
    expect(step.state).toBe(state);
    expect(
      step.reconnect ||
        step.refreshToken ||
        step.detach ||
        step.markDisconnected,
    ).toBe(false);
  });

  it("sync-acked does not reset the #537 token refetch or clear lost/read-only", () => {
    const state = {
      ...initialCollabAccess,
      lost: true,
      readOnly: true,
      refreshed: true,
      unresolvedRetried: true,
    };
    const step = nextCollabAccess(state, { kind: "sync-acked" });
    expect(step.state).toEqual({ ...state, unresolvedRetried: false });
  });

  it.each([undefined, "", "Forbidden", "ccc:collab-update-refused"])(
    "an unrelated reason (%s) keeps the #501 behaviour and the same state",
    (reason) => {
      const live = nextCollabAccess(initialCollabAccess, close(reason));
      expect(live).toEqual({
        state: initialCollabAccess,
        reconnect: true,
        refreshToken: false,
        markDisconnected: false,
        detach: false,
        disconnectSocket: false,
        retryAfterMs: 0,
      });
      expect(live.state).toBe(initialCollabAccess);
      const dead = nextCollabAccess(initialCollabAccess, close(reason, false));
      expect(dead.reconnect).toBe(false);
      expect(dead.detach).toBe(false);
    },
  );

  it("no #501/#537 path detaches", () => {
    for (const event of allEvents.filter(
      (e) => e.kind !== "server-close" || e.reason === undefined,
    )) {
      expect(nextCollabAccess(initialCollabAccess, event).detach).toBe(false);
    }
  });
});

describe("collab token expiry (the refreshed token, not the one captured at mount)", () => {
  const now = 1_000_000_000_000; // ms
  const stale = jwt(now / 1000 - 60); // the mount-time token, already expired in a long-open tab
  const fresh = jwt(now / 1000 + 3600); // what a refresh wrote to remote.configuration.token

  it("prefers the provider's configured (refreshed) token over the mount-time one", () => {
    expect(currentCollabToken(fresh, stale)).toBe(fresh);
    expect(currentCollabToken(null, stale)).toBe(stale);
    expect(currentCollabToken(() => "x", stale)).toBe(stale); // a function token: fall back
  });

  it("a refusal with a fresh refreshed token is NOT an expiry — so it reaches the lost state instead of looping", () => {
    const token = currentCollabToken(fresh, stale);
    expect(isCollabTokenExpired(token, now)).toBe(false);
    const event = {
      kind: "auth-failed" as const,
      tokenExpired: isCollabTokenExpired(token, now),
    };
    // #537: one refetch, then lost — bounded, never a refetch loop.
    const first = nextCollabAccess(initialCollabAccess, event);
    expect(first.state.lost).toBe(false);
    expect(nextCollabAccess(first.state, event).state.lost).toBe(true);
  });

  it("an expired, missing or unreadable token is an expiry (refresh it)", () => {
    expect(isCollabTokenExpired(stale, now)).toBe(true);
    expect(isCollabTokenExpired(undefined, now)).toBe(true);
    expect(isCollabTokenExpired("not-a-jwt", now)).toBe(true);
  });
});

// cccvu/wiki-v2#790 — the server's ws closes a socket whose frame exceeds its maxPayload with 1009. The provider would
// reconnect and resend the same frame every second, forever, so that close is a refusal like the guard's.
describe("a socket close with 1009 (a frame over the server's maxPayload) (#790)", () => {
  const rawClose = (code: number | undefined, reason = "") =>
    ({ kind: "server-close", socketConnected: false, reason, code }) as const;

  it("is refused: detach, stop editing, the too-big notice (#810: Discard first), never reconnect or refetch", () => {
    expect(WS_CLOSE_MESSAGE_TOO_BIG).toBe(1009);
    expect(classifyCollabCloseReason("", 1009)).toBe("refused");
    for (const step of [
      nextCollabAccess(initialCollabAccess, rawClose(1009)),
      nextCollabAccess(initialCollabAccess, rawClose(1009, "Max payload size exceeded")),
      // a 1009 wins over any reason, even a try-later one
      nextCollabAccess(initialCollabAccess, rawClose(1009, "ccc:collab-try-later")),
    ]) {
      expect(step.detach).toBe(true);
      expect(step.reconnect).toBe(false);
      expect(step.refreshToken).toBe(false);
      expect(step.markDisconnected).toBe(false);
      expect(step.retryAfterMs).toBe(0);
      expect(step.state.refused).toBe(true);
      expect(step.state.refusedTooBig).toBe(true);
      expect(collabAllowsEditing(step.state)).toBe(false);
    }
  });

  // #810 (review F1): only a 1009 says "too big"; every other refusal keeps Reload in the notice (anti-vacuity).
  it("no other refusal is too big, and refused stays final", () => {
    const others = [
      nextCollabAccess(initialCollabAccess, {
        kind: "server-close",
        socketConnected: true,
        reason: `${COLLAB_UPDATE_REFUSED_PREFIX}mark`,
        code: 1000,
      }),
      nextCollabAccess(
        { ...initialCollabAccess, unresolvedRetried: true },
        { kind: "server-close", socketConnected: true, reason: COLLAB_UPDATE_UNRESOLVED },
      ),
    ];
    for (const step of others) {
      expect(step.state.refused).toBe(true);
      expect(step.state.refusedTooBig).toBe(false);
    }
    const tooBig = nextCollabAccess(initialCollabAccess, rawClose(1009)).state;
    expect(nextCollabAccess(tooBig, { kind: "authenticated", scope: "read-write" }).state).toBe(tooBig);
    expect(initialCollabAccess.refusedTooBig).toBe(false);
  });

  it.each([1000, 1001, 1006, 1011, 4408, 4422, undefined])(
    "any other raw socket close (%s) stays an ordinary close the provider recovers from",
    (code) => {
      expect(classifyCollabCloseReason("", code)).toBe("other");
      const step = nextCollabAccess(initialCollabAccess, rawClose(code));
      expect(step).toEqual({
        state: initialCollabAccess,
        reconnect: false,
        refreshToken: false,
        markDisconnected: false,
        detach: false,
        disconnectSocket: false,
        retryAfterMs: 0,
      });
    },
  );

  it("a per-document CLOSE (code 1000) is still judged by its reason alone", () => {
    expect(
      nextCollabAccess(initialCollabAccess, {
        kind: "server-close",
        socketConnected: true,
        reason: "Server closed the connection",
        code: 1000,
      }).reconnect,
    ).toBe(true);
    expect(classifyCollabCloseReason(COLLAB_UPDATE_UNRESOLVED, 1000)).toBe(
      "unresolved",
    );
  });
});

// cccvu/wiki-v2#790 — only a refusal closes the socket: every other step keeps it (reconnect and token refresh need it).
describe("disconnectSocket", () => {
  it("is false for every event that is neither a refusal, a loss, a try-later nor a token refetch", () => {
    const events: CollabAccessEvent[] = [
      { kind: "server-close", socketConnected: true },
      { kind: "server-close", socketConnected: false, code: 1006 },
      { kind: "server-close", socketConnected: false, code: 4401 },
      { kind: "server-close", socketConnected: true, reason: COLLAB_UPDATE_UNRESOLVED },
      { kind: "authenticated", scope: "read-write" },
      { kind: "sync-acked" },
    ];
    for (const event of events) {
      expect([event, nextCollabAccess(initialCollabAccess, event).disconnectSocket]).toEqual([event, false]);
    }
  });

  // #810 (review R4-F3): the server closes a refused socket (4401) right after its PermissionDenied, and the provider
  // would reconnect it after a fixed 1 s with the OLD token, racing the refetch (a refused retry that then reads as
  // lost, and an extra pre-auth slot and auth-rate token). So every refetch closes the socket first.
  it("every token refetch (an expiry, or the first other refusal) closes the socket and is not lost", () => {
    for (const [prev, event] of [
      [initialCollabAccess, { kind: "auth-failed", tokenExpired: true }],
      [initialCollabAccess, { kind: "auth-failed", tokenExpired: false }],
      [{ ...initialCollabAccess, refreshed: true }, { kind: "auth-failed", tokenExpired: true }],
      [initialCollabAccess, { kind: "auth-failed", tokenExpired: false, reason: "permission-denied" }],
    ] as [CollabAccessState, CollabAccessEvent][]) {
      const step = nextCollabAccess(prev, event);
      expect([event, step.refreshToken, step.disconnectSocket]).toEqual([event, true, true]);
      expect(step.state.lost).toBe(false);
      expect(step.markDisconnected).toBe(false);
      expect(step.retryAfterMs).toBe(0);
      expect(step.detach).toBe(false);
    }
    // a step that does NOT refetch never closes the socket for it (anti-vacuity for the rule above)
    for (const event of [
      { kind: "authenticated", scope: "read-write" },
      { kind: "sync-acked" },
      { kind: "server-close", socketConnected: true },
    ] as CollabAccessEvent[]) {
      const step = nextCollabAccess(initialCollabAccess, event);
      expect(step.refreshToken).toBe(false);
      expect(step.disconnectSocket).toBe(false);
    }
  });

  // #790: the server closes a socket right after refusing its authentication and counts every unauthenticated socket
  // in a process-wide pool. A lost editor that kept reconnecting at the provider's pace (about once a second) would
  // hold a slot of that pool for as long as the tab stayed open, so a loss closes the socket and retries slowly.
  it("a loss (a second refusal, or a refetch that fails) closes the socket and retries after COLLAB_LOST_RETRY_MS, never refused", () => {
    const refetched = nextCollabAccess(initialCollabAccess, { kind: "auth-failed", tokenExpired: false });
    expect(refetched.refreshToken).toBe(true); // the first refusal refetches the token once (#537)
    expect(refetched.retryAfterMs).toBe(0); // ... and is not a loss (its socket closes only for the refetch, #810)
    for (const step of [
      nextCollabAccess(refetched.state, { kind: "auth-failed", tokenExpired: false }),
      nextCollabAccess(initialCollabAccess, { kind: "refresh-failed" }),
    ]) {
      expect(step.state.lost).toBe(true);
      expect(step.state.refused).toBe(false);
      expect(step.markDisconnected).toBe(true);
      expect(step.disconnectSocket).toBe(true);
      expect(step.detach).toBe(false); // the provider stays attached, so a later authentication recovers it
      expect(step.retryAfterMs).toBe(COLLAB_LOST_RETRY_MS);
      expect(COLLAB_LOST_RETRY_MS).toBeGreaterThanOrEqual(30_000);
      // the retry is judged like any other open: a later authentication clears the loss
      const back = nextCollabAccess(step.state, { kind: "authenticated", scope: "read-write" });
      expect(collabAllowsEditing(back.state)).toBe(true);
    }
    // a refusal on the retry, after the one refetch was spent, is a loss again (no refetch loop)
    const lost = nextCollabAccess(refetched.state, { kind: "auth-failed", tokenExpired: false });
    const again = nextCollabAccess(lost.state, { kind: "auth-failed", tokenExpired: false });
    expect(again.retryAfterMs).toBe(COLLAB_LOST_RETRY_MS);
    expect(again.refreshToken).toBe(false);
    // no other step schedules a retry
    for (const event of [
      { kind: "server-close", socketConnected: true },
      { kind: "authenticated", scope: "read-write" },
      { kind: "sync-acked" },
    ] as CollabAccessEvent[]) {
      expect(nextCollabAccess(initialCollabAccess, event).retryAfterMs).toBe(0);
    }
  });

  it("is true for a 1009 socket close (a frame over the server's maxPayload)", () => {
    const step = nextCollabAccess(initialCollabAccess, {
      kind: "server-close",
      socketConnected: false,
      code: WS_CLOSE_MESSAGE_TOO_BIG,
    });
    expect(step.disconnectSocket).toBe(true);
  });
});

// cccvu/wiki-v2#810 — the wiring in page-editor.tsx (seam 169) is now one controller (collab-access-controller.ts,
// tested with the real 4.7.1 provider in collab-access-controller.test.ts); these scans pin only what stays in the seam.
describe("page-editor wiring", () => {
  const source = readFileSync(
    join(__dirname, "..", "editor", "page-editor.tsx"),
    "utf8",
  );
  it("builds one controller per provider pair, binds the provider, and destroys the controller on unmount", () => {
    expect(source).toMatch(/const access = createCollabAccessController\(\{\s*socket,/);
    expect(source).toMatch(/access\.bind\(remote\);/);
    expect(source).toMatch(/collabAccessRef\.current = access;/);
    expect(source).toMatch(/return \(\) => \{\s*collabAccessRef\.current\?\.destroy\(\);/);
    // the rules live in the controller: no second copy of them in the seam
    expect(source).not.toMatch(/nextCollabAccess|onAuthenticationFailed|lostRetry/);
  });

  it("a refused editor is never re-attached and the visibility effect never reconnects it", () => {
    expect(source).toMatch(
      /if \(!providersReady \|\| !providersRef\.current\) return;\s*if \(collabAccessRef\.current\?\.state\.refused\) return;/,
    );
    expect(source).toMatch(
      /if \(!collabAccessRef\.current\?\.state\.refused\) providersRef\.current\?\.remote\.attach\(\);/,
    );
  });

  // #810 (final live check L2-2, EXT-4): the visibility effect undoes only a close (its own idle close, or the
  // controller's lost/try-later close), never a provider that is already retrying with its own backoff.
  it("the visibility effect reconnects only a socket nothing is retrying", () => {
    expect(source).toMatch(
      /if \(reopensOnVisible\(documentState, yjsConnectionStatus, socket\)\) \{\s*resetIdle\(\);\s*socket\.connect\(\);\s*\}\s*\}, \[isIdle, documentState, providersReady, resetIdle\]\);/,
    );
  });

  it("the refusal notice is told about a 1009", () => {
    expect(source).toMatch(/<CollabRefusalNotice\s*tooBig=\{collabAccess\.refusedTooBig\}/);
  });
});

// cccvu/wiki-v2#810 (T2, F2) — the server's "try later" answers are a bounded, slowed retry: never the #537 refetch,
// never lost, never refused, still editable; the wait grows to COLLAB_LOST_RETRY_MS and an authentication resets it.
describe("try later (#810)", () => {
  const tryLaterEvents: [string, CollabAccessEvent][] = [
    ["auth refused: auth rate", { kind: "auth-failed", tokenExpired: false, reason: "ccc:collab-auth-rate-limited" }],
    ["auth refused: connections", { kind: "auth-failed", tokenExpired: false, reason: "ccc:collab-user-connections" }],
    // a rate-limited refusal implies the token verified: it is try-later even when the token reads expired
    ["auth refused: auth rate, expired", { kind: "auth-failed", tokenExpired: true, reason: "ccc:collab-auth-rate-limited" }],
    ["socket close 4429", { kind: "server-close", socketConnected: false, code: 4429, reason: "ccc:collab-user-connections" }],
    ["socket close 1013", { kind: "server-close", socketConnected: false, code: 1013, reason: "ccc:collab-try-later" }],
    // the drain closes 1013 with whatever reason ws gives it
    ["socket close 1013, other reason", { kind: "server-close", socketConnected: false, code: 1013, reason: "Try Again Later" }],
    ["socket close 4429, no reason", { kind: "server-close", socketConnected: false, code: 4429 }],
    ["document CLOSE: connections", { kind: "server-close", socketConnected: true, code: 1000, reason: "ccc:collab-user-connections" }],
    ["document CLOSE: try later", { kind: "server-close", socketConnected: true, code: 1000, reason: "ccc:collab-try-later" }],
  ];

  it.each(tryLaterEvents)("%s ⇒ close the socket, show disconnected, retry later; no refetch, not lost, editable", (_, event) => {
    const prev = { ...initialCollabAccess, refreshed: true };
    const step = nextCollabAccess(prev, event);
    expect(step.state.refused).toBe(false);
    expect(step.state.lost).toBe(false);
    expect(step.state.refreshed).toBe(true); // untouched
    expect(step.state.tryLaterAttempts).toBe(1);
    expect(step.detach).toBe(false);
    expect(step.refreshToken).toBe(false);
    expect(step.reconnect).toBe(false);
    expect(step.disconnectSocket).toBe(true);
    expect(step.markDisconnected).toBe(true);
    expect(step.retryAfterMs).toBe(COLLAB_TRY_LATER_BASE_MS);
    expect(collabAllowsEditing(step.state)).toBe(true);
    expect(collabAwaitsRetry(step.state)).toBe(true);
    // and from the initial state too (a try-later never spends the #537 refetch)
    expect(nextCollabAccess(initialCollabAccess, event).state.refreshed).toBe(false);
  });

  it("repeated try-laters wait longer each time, capped at COLLAB_LOST_RETRY_MS; an authentication resets the wait", () => {
    let state: CollabAccessState = initialCollabAccess;
    const waits: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const step = nextCollabAccess(state, tryLaterEvents[i % tryLaterEvents.length][1]);
      state = step.state;
      waits.push(step.retryAfterMs);
      expect(collabAllowsEditing(state)).toBe(true);
    }
    expect(waits.slice(0, 5)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000]);
    for (let i = 1; i < waits.length; i += 1) expect(waits[i]).toBeGreaterThanOrEqual(waits[i - 1]);
    expect(Math.max(...waits)).toBe(COLLAB_LOST_RETRY_MS);
    const back = nextCollabAccess(state, { kind: "authenticated", scope: "read-write" });
    expect(back.state.tryLaterAttempts).toBe(0);
    expect(collabAwaitsRetry(back.state)).toBe(false);
    expect(nextCollabAccess(back.state, tryLaterEvents[0][1]).retryAfterMs).toBe(COLLAB_TRY_LATER_BASE_MS);
    // a huge count never overflows the wait
    expect(
      nextCollabAccess({ ...initialCollabAccess, tryLaterAttempts: 10_000 }, tryLaterEvents[0][1]).retryAfterMs,
    ).toBe(COLLAB_LOST_RETRY_MS);
  });

  it("a try-later while lost keeps the editor lost (only an authentication clears it)", () => {
    const step = nextCollabAccess({ ...initialCollabAccess, lost: true, refreshed: true }, tryLaterEvents[0][1]);
    expect(step.state.lost).toBe(true);
    expect(collabAllowsEditing(step.state)).toBe(false);
    expect(step.refreshToken).toBe(false);
  });

  // Anti-vacuity: the classes next door keep their own paths.
  it.each([
    ["permission-denied", "permission-denied"],
    ["no reason", undefined],
    ["a lookalike", "ccc:collab-auth-rate-limitedx"],
    ["a prefix", "ccc:collab-user-connection"],
    ["the close-only reason", "ccc:collab-try-later"],
  ])("an auth refusal with %s keeps the #537 path (refetch once, then lost)", (_, reason) => {
    const first = nextCollabAccess(initialCollabAccess, { kind: "auth-failed", tokenExpired: false, reason });
    expect(first.refreshToken).toBe(true);
    expect(first.state.tryLaterAttempts).toBe(0);
    const second = nextCollabAccess(first.state, { kind: "auth-failed", tokenExpired: false, reason });
    expect(second.state.lost).toBe(true);
    expect(second.retryAfterMs).toBe(COLLAB_LOST_RETRY_MS);
  });

  it("classifies only the try-later codes and reasons; the close-only reasons are not auth reasons", () => {
    expect(classifyCollabCloseReason(undefined, 1013)).toBe("try-later");
    expect(classifyCollabCloseReason("", 4429)).toBe("try-later");
    expect(classifyCollabCloseReason("ccc:collab-try-later", 1000)).toBe("try-later");
    expect(classifyCollabCloseReason("ccc:collab-user-connections")).toBe("try-later");
    for (const [reason, code] of [
      ["ccc:collab-auth-rate-limited", 1000], // an auth refusal reason, never a close reason
      ["ccc:collab-try-laterx", 1000],
      ["", 4401],
      ["", 1012],
      ["", 4428],
    ] as [string, number][]) {
      expect([reason, code, classifyCollabCloseReason(reason, code)]).toEqual([reason, code, "other"]);
    }
    // a refusal reason wins over a try-later code
    expect(classifyCollabCloseReason(`${COLLAB_UPDATE_REFUSED_PREFIX}mark`, 1013)).toBe("refused");
  });

  it("a refused editor ignores try-later", () => {
    const refused = { ...initialCollabAccess, refused: true };
    const step = nextCollabAccess(refused, tryLaterEvents[0][1]);
    expect(step.state).toBe(refused);
    expect(step.disconnectSocket || step.markDisconnected || step.retryAfterMs > 0).toBe(false);
    expect(collabAwaitsRetry({ ...refused, tryLaterAttempts: 3, lost: true })).toBe(false);
  });
});

describe("collabRetryDelay (#810)", () => {
  it("is between half and all of the wait, never below COLLAB_RETRY_MIN_MS", () => {
    expect(collabRetryDelay(60_000, () => 0)).toBe(30_000);
    expect(collabRetryDelay(60_000, () => 1)).toBe(60_000);
    expect(collabRetryDelay(5_000, () => 0.5)).toBe(3_750);
    expect(collabRetryDelay(1_000, () => 0)).toBe(COLLAB_RETRY_MIN_MS);
    expect(collabRetryDelay(5_000, () => 7)).toBe(5_000); // a bad random source is clamped
    expect(collabRetryDelay(5_000, () => -1)).toBe(2_500);
    for (let i = 0; i < 200; i += 1) {
      const d = collabRetryDelay(5_000);
      expect(d).toBeGreaterThanOrEqual(2_500);
      expect(d).toBeLessThanOrEqual(5_000);
    }
  });
});
