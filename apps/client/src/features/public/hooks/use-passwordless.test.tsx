import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same load-bearing guarantee as the password login (issue #46), now for passwordless: a verified
// sign-in only sets the PLATFORM session, so openDocmostSession() (the BFF bridge) MUST run before
// navigating, and a bridge failure must roll the platform session back and NOT navigate.

const navigateMock = vi.fn();

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock("@/features/auth/services/auth-service", () => ({
  openDocmostSession: vi.fn(async () => {}),
  logout: vi.fn(async () => {}),
}));

vi.mock("@/features/public/services/public-service.ts", () => ({
  requestPasswordless: vi.fn(async () => ({ message: "ok" })),
  verifyPasswordless: vi.fn(async () => ({ id: "u1", email: "a@b.edu", workspaceId: "ws" })),
}));

vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (s: string) => s }) }));

import { logout, openDocmostSession } from "@/features/auth/services/auth-service";
import { verifyPasswordless } from "@/features/public/services/public-service.ts";
import { usePasswordless } from "@/features/public/hooks/use-passwordless.ts";

describe("usePasswordless().completeSignIn — verify → BFF bridge → navigate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs the BFF exchange AFTER verify and BEFORE navigating", async () => {
    const { result } = renderHook(() => usePasswordless());

    await act(async () => {
      await result.current.completeSignIn({ token: "raw-link-token" });
    });

    expect(verifyPasswordless).toHaveBeenCalledWith({ token: "raw-link-token" });
    expect(openDocmostSession).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledTimes(1);

    const verifyOrder = (verifyPasswordless as any).mock.invocationCallOrder[0];
    const bridgeOrder = (openDocmostSession as any).mock.invocationCallOrder[0];
    const navOrder = navigateMock.mock.invocationCallOrder[0];
    expect(verifyOrder).toBeLessThan(bridgeOrder);
    expect(bridgeOrder).toBeLessThan(navOrder);
    // Normal (non-resume) path: the spinner is CLEARED (the redirect-hold only applies to the resume branch).
    expect(result.current.isVerifying).toBe(false);
  });

  it("rolls back (logout) and does NOT navigate if the BFF bridge fails", async () => {
    (openDocmostSession as any).mockRejectedValueOnce(new Error("bridge down"));
    const { result } = renderHook(() => usePasswordless());

    await act(async () => {
      await expect(result.current.completeSignIn({ email: "a@b.edu", otp: "123456" })).rejects.toThrow();
    });

    expect(logout).toHaveBeenCalledTimes(1); // platform session rolled back
    expect(navigateMock).not.toHaveBeenCalled(); // no 401 redirect loop
    expect(result.current.isVerifying).toBe(false); // spinner cleared on the error path (no stuck spinner)
  });

  // INVARIANT (issue #52, PR 48 Round-2 test re-review): when the compensating rollback logout() ITSELF
  // rejects, the `.catch(() => undefined)` swallow (use-passwordless.ts) must keep the ORIGINAL bridge
  // failure — the `stage: "bridge"` sentinel — as the surfaced error, never the rollback error, and must
  // still not navigate. Otherwise a future refactor (or a logout() that stops using Promise.allSettled)
  // could let a rollback error mask the real cause and mislead the interstitial page. Mutation-verified:
  // deleting the `.catch(() => undefined)` makes the rollback rejection propagate → this test goes red.
  it("swallows a rollback-logout() failure and still surfaces the bridge sentinel (no navigate)", async () => {
    (openDocmostSession as any).mockRejectedValueOnce(new Error("bridge down"));
    (logout as any).mockRejectedValueOnce(new Error("rollback logout failed"));
    const { result } = renderHook(() => usePasswordless());

    let caught: any;
    await act(async () => {
      caught = await result.current
        .completeSignIn({ email: "a@b.edu", otp: "123456" })
        .then(
          () => {
            throw new Error("completeSignIn should have rejected");
          },
          (e) => e,
        );
    });

    // The original bridge sentinel wins — NOT the "rollback logout failed" error:
    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toBe("session-bridge-failed");
    expect(caught.stage).toBe("bridge");
    expect(logout).toHaveBeenCalledTimes(1); // rollback attempted exactly once
    expect(navigateMock).not.toHaveBeenCalled(); // still no navigation
  });
});

// #302 — when sign-in began from inside an MCP OAuth flow, the platform returns `resume: true` on verify.
// The hook must then FULL-PAGE navigate back to /oauth/authorize (a platform route React-Router can't reach),
// NOT SPA-navigate home. The Docmost bridge is best-effort here and its failure must NOT log out — the OAuth
// consent needs only the platform session, and a rollback would wipe the very session the resume depends on.
describe("usePasswordless().completeSignIn — OAuth resume (#302)", () => {
  // jsdom's window.location.assign is non-configurable, so stub the whole location object for these tests
  // (the resume path only reads window.location.assign) and restore it afterwards.
  const realLocation = window.location;
  let assign: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        href: "http://localhost:5173/login",
        origin: "http://localhost:5173",
        pathname: "/login",
        search: "",
        hash: "",
        assign,
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", { configurable: true, value: realLocation });
  });

  it("on resume: bridges best-effort, then FULL-PAGE navigates to /oauth/authorize (never SPA navigate)", async () => {
    (verifyPasswordless as any).mockResolvedValueOnce({ id: "u1", email: "a@b.edu", workspaceId: "ws", resume: true });
    const { result } = renderHook(() => usePasswordless());

    await act(async () => {
      await result.current.completeSignIn({ email: "a@b.edu", otp: "123456" });
    });

    expect(openDocmostSession).toHaveBeenCalledTimes(1); // best-effort so later same-browser wiki use works
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/oauth/authorize"); // a CONSTANT same-origin platform route (no open redirect)
    expect(navigateMock).not.toHaveBeenCalled(); // NOT a client-side SPA navigate (would 404 on a platform route)
    expect(logout).not.toHaveBeenCalled();
    // the bridge runs before the resume navigation
    expect((openDocmostSession as any).mock.invocationCallOrder[0]).toBeLessThan(assign.mock.invocationCallOrder[0]);
    // The spinner stays UP through the full-page redirect (never re-enable the button mid-nav → no double-submit).
    expect(result.current.isVerifying).toBe(true);
  });

  it("on resume: a bridge FAILURE is non-fatal — still resumes /oauth/authorize and does NOT logout (platform session preserved)", async () => {
    (verifyPasswordless as any).mockResolvedValueOnce({ id: "u1", email: "a@b.edu", workspaceId: "ws", resume: true });
    (openDocmostSession as any).mockRejectedValueOnce(new Error("bridge down"));
    const { result } = renderHook(() => usePasswordless());

    await act(async () => {
      // Must NOT throw — the resume tolerates a bridge outage.
      await result.current.completeSignIn({ email: "a@b.edu", otp: "123456" });
    });

    expect(logout).not.toHaveBeenCalled(); // never wipe the platform session the OAuth resume needs
    expect(assign).toHaveBeenCalledWith("/oauth/authorize"); // resume completes on the platform session alone
    expect(navigateMock).not.toHaveBeenCalled();
    expect(result.current.isVerifying).toBe(true); // spinner held through the redirect even on a bridge failure
  });
});
