import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COLLAB_UPDATE_REFUSED_PREFIX,
  COLLAB_UPDATE_UNRESOLVED,
  CollabAccessEvent,
  CollabAccessState,
  classifyCollabCloseReason,
  collabAllowsEditing,
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

  it("is refused: detach, stop editing, the generic notice, never reconnect or refetch", () => {
    expect(WS_CLOSE_MESSAGE_TOO_BIG).toBe(1009);
    expect(classifyCollabCloseReason("", 1009)).toBe("refused");
    for (const step of [
      nextCollabAccess(initialCollabAccess, rawClose(1009)),
      nextCollabAccess(initialCollabAccess, rawClose(1009, "Max payload size exceeded")),
    ]) {
      expect(step.detach).toBe(true);
      expect(step.reconnect).toBe(false);
      expect(step.refreshToken).toBe(false);
      expect(step.markDisconnected).toBe(false);
      expect(step.state.refused).toBe(true);
      expect(collabAllowsEditing(step.state)).toBe(false);
    }
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
  it("is false for every event that is not a refusal", () => {
    const events: CollabAccessEvent[] = [
      { kind: "server-close", socketConnected: true },
      { kind: "server-close", socketConnected: false, code: 1006 },
      { kind: "server-close", socketConnected: true, reason: COLLAB_UPDATE_UNRESOLVED },
      { kind: "auth-failed", tokenExpired: true },
      { kind: "auth-failed", tokenExpired: false },
      { kind: "refresh-failed" },
      { kind: "authenticated", scope: "read-write" },
      { kind: "sync-acked" },
    ];
    for (const event of events) {
      expect([event, nextCollabAccess(initialCollabAccess, event).disconnectSocket]).toEqual([event, false]);
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

// cccvu/wiki-v2#790 — the wiring in page-editor.tsx (seam 169): the step closes the socket, and nothing reopens it.
describe("page-editor wiring", () => {
  const source = readFileSync(
    join(__dirname, "..", "editor", "page-editor.tsx"),
    "utf8",
  );
  it("a disconnectSocket step disconnects the editor's socket, after the detach", () => {
    const detach = source.indexOf("if (step.detach) remote.detach();");
    const disconnect = source.indexOf(
      "if (step.disconnectSocket) socket.disconnect();",
    );
    expect(detach).toBeGreaterThan(-1);
    expect(disconnect).toBeGreaterThan(detach);
  });
  it("a refused editor is not current (a token refetch in flight cannot reopen) and the visibility effect never reconnects it", () => {
    expect(source).toMatch(
      /const isCurrent = \(\) =>\s*providersRef\.current\?\.socket === socket &&\s*!collabAccessRef\.current\.refused;/,
    );
    expect(source).toMatch(
      /if \(!providersReady \|\| !providersRef\.current\) return;\s*if \(collabAccessRef\.current\.refused\) return;/,
    );
  });
});
