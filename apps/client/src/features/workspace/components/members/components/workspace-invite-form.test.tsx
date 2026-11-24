// CCC (fork-owned test, wiki-v2 #858): the native invite form also opens from the global sidebar, so after a
// successful send it must go to the members page's Invites tab by ABSOLUTE path (a relative "?tab=invites"
// left /home?tab=invites, which shows nothing), and a refused send must keep the modal open.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

const postMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({
  default: { post: (...a: unknown[]) => postMock(...a) },
}));
const notifyMock = vi.hoisted(() => vi.fn());
vi.mock("@mantine/notifications", () => ({
  notifications: { show: (...a: unknown[]) => notifyMock(...a) },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
// The group picker runs its own queries; it is not what this test is about.
vi.mock("@/features/group/components/multi-group-select.tsx", () => ({
  MultiGroupSelect: () => null,
}));

import { WorkspaceInviteForm } from "./workspace-invite-form";

beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
  if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

function Location() {
  const location = useLocation();
  return (
    <div data-testid="location">{location.pathname + location.search}</div>
  );
}

function renderForm(onClose = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MantineProvider env="test">
        <MemoryRouter initialEntries={["/home"]}>
          <Routes>
            <Route
              path="*"
              element={
                <>
                  <WorkspaceInviteForm onClose={onClose} />
                  <Location />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </MantineProvider>
    </QueryClientProvider>,
  );
  return onClose;
}

function addEmail(email: string) {
  const input = screen.getByPlaceholderText("enter valid emails addresses");
  fireEvent.change(input, { target: { value: email } });
  fireEvent.keyDown(input, { key: "Enter" });
}

beforeEach(() => {
  postMock.mockReset();
  notifyMock.mockReset();
});

describe("WorkspaceInviteForm (#858)", () => {
  it("goes to /settings/members?tab=invites from another page after a successful send", async () => {
    postMock.mockResolvedValue({ success: true, status: 200 });
    const onClose = renderForm();
    addEmail("new.person@example.edu");
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));

    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(
        "/settings/members?tab=invites",
      ),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(postMock).toHaveBeenCalledWith("/workspace/invites/create", {
      role: "member",
      emails: ["new.person@example.edu"],
      groupIds: [],
    });
  });

  it("keeps the modal open and stays put when the send is refused", async () => {
    postMock.mockRejectedValue(
      Object.assign(new Error("HTTP 400"), {
        response: { status: 400, data: { message: "Invite refused" } },
      }),
    );
    const onClose = renderForm();
    addEmail("new.person@example.edu");
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));

    await waitFor(() =>
      expect(notifyMock).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Invite refused", color: "red" }),
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("location").textContent).toBe("/home");
  });
});
