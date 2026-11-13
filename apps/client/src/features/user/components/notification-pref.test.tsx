import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { Provider, createStore } from "jotai";

// CCC (wiki-v2 UI cleanup): remote mode sends no Docmost mail, so only "Page updates" (which also
// gates the in-app page-update notification) is offered there.
const nativeState = vi.hoisted(() => ({ value: false }));
vi.mock("@/features/auth-native/lib/auth-mode.ts", () => ({
  isNativeAuthEnabled: () => nativeState.value,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock("@/features/user/services/user-service.ts", () => ({
  updateUser: vi.fn(),
}));
// A plain atom: the real one is backed by atomWithStorage, which jsdom's missing localStorage resets.
vi.mock("@/features/user/atoms/current-user-atom.ts", async () => {
  const { atom } = await import("jotai");
  return { userAtom: atom({ settings: {} }) };
});

import NotificationPref from "./notification-pref";

const ALL = [
  "Page updates",
  "Page mentions",
  "Comment mentions",
  "New comments",
  "Resolved comments",
];

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

beforeEach(() => {
  nativeState.value = false;
});

function renderPref() {
  const store = createStore();
  return render(
    <Provider store={store}>
      <MantineProvider>
        <NotificationPref />
      </MantineProvider>
    </Provider>,
  );
}

describe("NotificationPref", () => {
  it("remote mode: one 'Page updates' toggle under 'Notifications'", () => {
    renderPref();
    expect(screen.getByRole("heading", { name: "Notifications" })).toBeTruthy();
    expect(screen.getAllByRole("switch")).toHaveLength(1);
    expect(screen.getByLabelText("Page updates")).toBeTruthy();
    for (const label of ALL.slice(1)) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it("native mode: all five toggles under 'Email notifications', as upstream", () => {
    nativeState.value = true;
    renderPref();
    expect(
      screen.getByRole("heading", { name: "Email notifications" }),
    ).toBeTruthy();
    expect(screen.getAllByRole("switch")).toHaveLength(5);
    for (const label of ALL) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
  });
});
