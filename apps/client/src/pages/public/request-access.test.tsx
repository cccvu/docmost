import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter } from "react-router-dom";

/**
 * Regression suite for the request-access page hardening (GitHub #29) — NOT upstream Docmost code.
 *
 * Pins the three fixes: (1) the success feedback is a single inline `role="status"` Alert with NO toast;
 * (2) a submit failure surfaces as an inline, form-associated `role="alert"` Alert (reaches screen
 * readers) with NO toast; (3) the 2.5s post-success redirect timer is CLEARED on unmount, so a visitor
 * who leaves within the window is not yanked to /login and navigate() is not called on an unmounted tree.
 */

const requestAccess = vi.fn();
const navigate = vi.fn();
const notificationsShow = vi.fn();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock("react-helmet-async", () => ({ Helmet: () => null }));
vi.mock("@/lib/config.ts", () => ({ getAppName: () => "Wiki" }));
vi.mock("@/features/public/components/public-shell.tsx", () => ({
  PublicShell: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@/features/public/services/public-service.ts", () => ({
  requestAccess: (...args: unknown[]) => requestAccess(...args),
}));
// The page must NOT fire a toast; this spy would catch a regression that re-introduces one.
vi.mock("@mantine/notifications", () => ({
  notifications: { show: notificationsShow },
}));
vi.mock("react-router-dom", async (orig) => {
  const actual = await orig<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navigate };
});

import RequestAccess from "./request-access";
import APP_ROUTE from "@/lib/app-route.ts";

const SUCCESS_MSG =
  "Access requested. Your account is pending administrator approval and cannot sign in yet.";

beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
});

beforeEach(() => {
  requestAccess.mockReset();
  navigate.mockReset();
  notificationsShow.mockReset();
});

function renderPage() {
  return render(
    <MantineProvider>
      <MemoryRouter initialEntries={["/request-access"]}>
        <RequestAccess />
      </MemoryRouter>
    </MantineProvider>,
  );
}

const typeEmail = (value = "user@example.edu") =>
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value } });
const submit = () =>
  screen.getByRole("button", { name: /request access/i });

// Fire the submit and flush the awaited requestAccess promise + resulting state/effect.
async function submitAndFlush() {
  await act(async () => {
    fireEvent.click(submit());
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("RequestAccess — feedback is accessible and single-channel (#29)", () => {
  it("shows one inline role=status Alert on success and fires NO toast", async () => {
    requestAccess.mockResolvedValueOnce({ message: SUCCESS_MSG });
    renderPage();
    typeEmail();
    await submitAndFlush();

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain(SUCCESS_MSG);
    expect(notificationsShow).not.toHaveBeenCalled();
  });

  it("shows an inline role=alert Alert on submit failure (reaches SRs) and fires NO toast", async () => {
    requestAccess.mockRejectedValueOnce(new Error("network"));
    renderPage();
    typeEmail();
    await submitAndFlush();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/couldn't submit your request/i);
    expect(notificationsShow).not.toHaveBeenCalled();
    // failure keeps the form (does not flip to the success state)
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("RequestAccess — the redirect timer is cleaned up (#29)", () => {
  it("does NOT navigate after unmount within the redirect window", async () => {
    vi.useFakeTimers();
    try {
      requestAccess.mockResolvedValueOnce({ message: SUCCESS_MSG });
      const { unmount } = renderPage();
      typeEmail();
      await submitAndFlush();
      // leave before the 2.5s timer fires
      unmount();
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("DOES redirect to sign-in ~2.5s after success (positive control)", async () => {
    vi.useFakeTimers();
    try {
      requestAccess.mockResolvedValueOnce({ message: SUCCESS_MSG });
      renderPage();
      typeEmail();
      await submitAndFlush();
      await act(async () => {
        vi.advanceTimersByTime(2500);
      });
      expect(navigate).toHaveBeenCalledWith(APP_ROUTE.AUTH.LOGIN);
    } finally {
      vi.useRealTimers();
    }
  });
});
