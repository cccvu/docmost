import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import React from "react";

// CCC (wiki-v2 #917): handleLogout clears the stored user first, which unmounts the signed-in tree. In
// native mode logout() rethrows a failed POST, and the tab used to stay blank with an unhandled
// rejection. It now reloads: the session is still open, so the reload honestly shows the user signed in.
const svc = vi.hoisted(() => ({ logout: vi.fn() }));
vi.mock("@/features/auth/services/auth-service", () => ({
  logout: svc.logout,
  setupWorkspace: vi.fn(),
}));
vi.mock("@/features/workspace/services/workspace-service.ts", () => ({
  acceptInvitation: vi.fn(),
  createWorkspace: vi.fn(),
}));
vi.mock("@/ee/utils.ts", () => ({
  exchangeTokenRedirectUrl: vi.fn(),
  getHostnameUrl: vi.fn(),
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import useAuth from "./use-auth";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";

const realLocation = window.location;
const nav = vi.hoisted(() => ({ replace: vi.fn(), reload: vi.fn() }));

beforeEach(() => {
  svc.logout.mockReset();
  nav.replace.mockReset();
  nav.reload.mockReset();
  Object.defineProperty(window, "location", {
    value: { replace: nav.replace, reload: nav.reload },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    value: realLocation,
    writable: true,
    configurable: true,
  });
});

function setup() {
  const store = createStore();
  store.set(currentUserAtom, { user: { id: "u1" }, workspace: { id: "w1" } } as never);
  const wrapper = ({ children }: React.PropsWithChildren) => (
    <Provider store={store}>{children}</Provider>
  );
  const { result } = renderHook(() => useAuth(), { wrapper });
  return { result, store };
}

describe("useAuth().logout (#917)", () => {
  it("logout succeeds: clears the stored user and goes to /login?logout=1", async () => {
    svc.logout.mockResolvedValue(undefined);
    const { result, store } = setup();
    await act(() => result.current.logout());
    expect(store.get(currentUserAtom)).toBeNull();
    expect(nav.replace).toHaveBeenCalledWith("/login?logout=1");
    expect(nav.reload).not.toHaveBeenCalled();
  });

  it("native logout POST fails: reloads (never a blank tree, never a false sign-out redirect)", async () => {
    svc.logout.mockRejectedValue(new Error("network"));
    const { result } = setup();
    await expect(act(() => result.current.logout())).resolves.toBeUndefined();
    expect(nav.reload).toHaveBeenCalledTimes(1);
    expect(nav.replace).not.toHaveBeenCalled();
  });
});
