import { describe, expect, it } from "vitest";
import {
  collabAllowsEditing,
  currentCollabToken,
  initialCollabAccess,
  isCollabTokenExpired,
  nextCollabAccess,
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
      lost: false,
      readOnly: true,
      refreshed: false,
    });
    expect(collabAllowsEditing(step.state)).toBe(false);
  });

  it("a read-write authentication (e.g. access restored) clears lost and read-only", () => {
    const step = nextCollabAccess(
      { lost: true, readOnly: true, refreshed: true },
      { kind: "authenticated", scope: "read-write" },
    );
    expect(step.state).toEqual({
      lost: false,
      readOnly: false,
      refreshed: false,
    });
    expect(collabAllowsEditing(step.state)).toBe(true);
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
