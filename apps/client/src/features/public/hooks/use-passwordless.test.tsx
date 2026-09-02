import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  });

  it("rolls back (logout) and does NOT navigate if the BFF bridge fails", async () => {
    (openDocmostSession as any).mockRejectedValueOnce(new Error("bridge down"));
    const { result } = renderHook(() => usePasswordless());

    await act(async () => {
      await expect(result.current.completeSignIn({ email: "a@b.edu", otp: "123456" })).rejects.toThrow();
    });

    expect(logout).toHaveBeenCalledTimes(1); // platform session rolled back
    expect(navigateMock).not.toHaveBeenCalled(); // no 401 redirect loop
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
