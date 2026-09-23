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

  it("a refusal that is not a token expiry means access is lost: stop editing, show the lost status", () => {
    const step = nextCollabAccess(initialCollabAccess, {
      kind: "auth-failed",
      tokenExpired: false,
    });
    expect(step.state.lost).toBe(true);
    expect(step.markDisconnected).toBe(true);
    expect(collabAllowsEditing(step.state)).toBe(false);
  });

  it("an expired token keeps the upstream refresh path and changes nothing here", () => {
    const step = nextCollabAccess(initialCollabAccess, {
      kind: "auth-failed",
      tokenExpired: true,
    });
    expect(step.state).toEqual(initialCollabAccess);
    expect(step.markDisconnected).toBe(false);
  });

  it("a demoted user re-authenticates read-only and can no longer edit", () => {
    const step = nextCollabAccess(initialCollabAccess, {
      kind: "authenticated",
      scope: "readonly",
    });
    expect(step.state).toEqual({ lost: false, readOnly: true });
    expect(collabAllowsEditing(step.state)).toBe(false);
  });

  it("a read-write authentication (e.g. access restored) clears lost and read-only", () => {
    const step = nextCollabAccess(
      { lost: true, readOnly: true },
      { kind: "authenticated", scope: "read-write" },
    );
    expect(step.state).toEqual({ lost: false, readOnly: false });
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
    const step = nextCollabAccess(initialCollabAccess, {
      kind: "auth-failed",
      tokenExpired: isCollabTokenExpired(token, now),
    });
    expect(step.state.lost).toBe(true);
  });

  it("an expired, missing or unreadable token is an expiry (refresh it)", () => {
    expect(isCollabTokenExpired(stale, now)).toBe(true);
    expect(isCollabTokenExpired(undefined, now)).toBe(true);
    expect(isCollabTokenExpired("not-a-jwt", now)).toBe(true);
  });
});
