import { describe, it, expect, beforeAll, beforeEach, vi, type Mock } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import RootGate from "./root-gate";
import useCurrentUser from "@/features/user/hooks/use-current-user";

vi.mock("@/features/user/hooks/use-current-user", () => ({ default: vi.fn() }));
vi.mock("@/pages/public/public-home", () => ({
  default: () => <div>PUBLIC_HOME</div>,
}));

const mockUser = useCurrentUser as unknown as Mock;

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
});

beforeEach(() => mockUser.mockReset());

function renderGate() {
  return render(
    <MantineProvider>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<RootGate />} />
          <Route path="/home" element={<div>HOME_ROUTE</div>} />
        </Routes>
      </MemoryRouter>
    </MantineProvider>,
  );
}

describe("RootGate", () => {
  it("shows a loader while the auth probe is in flight", () => {
    mockUser.mockReturnValue({ isLoading: true, data: undefined });
    renderGate();
    expect(screen.getByLabelText("Loading")).toBeTruthy();
  });

  it("redirects a signed-in visitor to /home (signed-in experience unchanged)", () => {
    mockUser.mockReturnValue({ isLoading: false, data: { user: { id: "u1" } } });
    renderGate();
    expect(screen.getByText("HOME_ROUTE")).toBeTruthy();
    expect(screen.queryByText("PUBLIC_HOME")).toBeNull();
  });

  it("renders the public landing for an anonymous visitor (no bounce to /login)", () => {
    mockUser.mockReturnValue({ isLoading: false, data: undefined });
    renderGate();
    expect(screen.getByText("PUBLIC_HOME")).toBeTruthy();
    expect(screen.queryByText("HOME_ROUTE")).toBeNull();
  });
});
