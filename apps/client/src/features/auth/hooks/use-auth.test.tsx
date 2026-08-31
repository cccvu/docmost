import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The load-bearing guarantee for issue #46: after a platform login, the Docmost session exchange
// (POST /bff/docmost/session) must complete BEFORE navigation, so UserProvider's /api/users/me is
// authenticated when the app mounts. If the exchange fails, we must NOT navigate (a 401 would then
// bounce the user straight back to /login — an infinite loop).

const navigateMock = vi.fn();

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock("@/features/auth/services/auth-service", () => ({
  login: vi.fn(async () => ({})),
  openDocmostSession: vi.fn(async () => {}),
  logout: vi.fn(async () => {}),
  forgotPassword: vi.fn(async () => {}),
  passwordReset: vi.fn(async () => ({})),
  setupWorkspace: vi.fn(async () => ({})),
  verifyUserToken: vi.fn(async () => ({})),
}));

vi.mock("@mantine/notifications", () => ({
  notifications: { show: vi.fn() },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (s: string) => s }),
}));

import { notifications } from "@mantine/notifications";
import { login, logout, openDocmostSession } from "@/features/auth/services/auth-service";
import useAuth from "@/features/auth/hooks/use-auth";

describe("useAuth().signIn — platform login → Docmost session exchange → navigate (issue #46)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs the BFF exchange AFTER login and BEFORE navigating", async () => {
    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await result.current.signIn({ email: "cccadmin@vanderbilt.edu", password: "pw" });
    });

    expect(login).toHaveBeenCalledTimes(1);
    expect(openDocmostSession).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledTimes(1);

    const loginOrder = (login as any).mock.invocationCallOrder[0];
    const exchangeOrder = (openDocmostSession as any).mock.invocationCallOrder[0];
    const navigateOrder = navigateMock.mock.invocationCallOrder[0];

    expect(loginOrder).toBeLessThan(exchangeOrder);
    expect(exchangeOrder).toBeLessThan(navigateOrder);
  });

  it("does NOT navigate when the exchange fails (avoids a 401 redirect loop) and shows an error", async () => {
    (openDocmostSession as any).mockRejectedValueOnce({
      response: { data: { message: "exchange failed" } },
    });

    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await result.current.signIn({ email: "cccadmin@vanderbilt.edu", password: "pw" });
    });

    expect(login).toHaveBeenCalledTimes(1);
    expect(openDocmostSession).toHaveBeenCalledTimes(1);
    // Rolls back the half-created platform session so no live platform cookie is left behind.
    expect(logout).toHaveBeenCalledTimes(1);
    expect(navigateMock).not.toHaveBeenCalled();
    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: "exchange failed", color: "red" }),
    );
  });

  it("on an MFA response, navigates to the challenge and does NOT open a Docmost session", async () => {
    (login as any).mockResolvedValueOnce({ userHasMfa: true });

    const { result } = renderHook(() => useAuth());
    await act(async () => {
      await result.current.signIn({ email: "cccadmin@vanderbilt.edu", password: "pw" });
    });

    expect(openDocmostSession).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith(expect.stringContaining("mfa"));
  });

  it("shows a fallback message when a failed exchange carries no error message", async () => {
    (openDocmostSession as any).mockRejectedValueOnce({}); // no response.data.message

    const { result } = renderHook(() => useAuth());
    await act(async () => {
      await result.current.signIn({ email: "cccadmin@vanderbilt.edu", password: "pw" });
    });

    expect(navigateMock).not.toHaveBeenCalled();
    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Login failed"), color: "red" }),
    );
  });
});
