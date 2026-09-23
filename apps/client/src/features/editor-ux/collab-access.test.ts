import { describe, expect, it } from "vitest";
import {
  collabAllowsEditing,
  initialCollabAccess,
  nextCollabAccess,
} from "./collab-access";

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
