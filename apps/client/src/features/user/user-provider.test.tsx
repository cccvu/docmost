import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { Provider, createStore } from "jotai";

// CCC (wiki-v2 #911): UserProvider stores the loaded user in `currentUserAtom` from an effect, after
// its first render with the data. A direct load with no stored user (fresh profile, after sign-out)
// rendered the children against a null `userAtom`, and Preferences crashed reading `user.settings`.
const query = vi.hoisted(() => ({
  state: {} as {
    data?: unknown;
    isLoading: boolean;
    isError: boolean;
    error: unknown;
  },
}));
vi.mock("@/features/user/hooks/use-current-user", () => ({
  default: () => query.state,
}));
vi.mock("socket.io-client", () => ({
  io: () => ({ on: vi.fn(), disconnect: vi.fn() }),
}));
vi.mock("@/features/websocket/use-query-subscription.ts", () => ({
  useQuerySubscription: () => {},
}));
vi.mock("@/features/websocket/use-tree-socket.ts", () => ({
  useTreeSocket: () => {},
}));
vi.mock("@/features/notification/hooks/use-notification-socket.ts", () => ({
  useNotificationSocket: () => {},
}));
vi.mock("@/features/websocket/use-socket-auth-probe", () => ({
  useSocketAuthProbe: () => {},
}));
vi.mock("@/features/identity-reconcile/use-identity-reconcile", () => ({
  useIdentityReconcile: () => {},
}));
vi.mock("@/features/auth/queries/auth-query.tsx", () => ({
  useCollabToken: () => ({ data: undefined }),
}));
vi.mock("@/ee/entitlement/use-entitlements", () => ({
  useEntitlements: () => ({ data: undefined }),
}));
vi.mock("@/lib/date-locale.ts", () => ({
  changeAppLanguage: vi.fn(async () => {}),
}));
vi.mock("@/features/auth-native/lib/auth-mode.ts", () => ({
  isNativeAuthEnabled: () => false,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string) => k,
    i18n: { language: "en-US", resolvedLanguage: "en-US" },
  }),
}));
vi.mock("@/features/user/services/user-service.ts", () => ({
  updateUser: vi.fn(),
}));

import { UserProvider } from "./user-provider";
import PageWidthPref from "./components/page-width-pref";
import NotificationPref from "./components/notification-pref";

// The saved settings differ from both toggles' null-user fallbacks, so a toggle seeded before the
// user arrived shows the wrong state.
const loaded = {
  user: {
    id: "u1",
    name: "Ada",
    locale: "en-US",
    settings: {
      preferences: { fullPageWidth: true },
      notifications: { "page.updated": false },
    },
  },
  workspace: { id: "w1" },
};

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
  window.localStorage?.removeItem("currentUser");
  query.state = { data: loaded, isLoading: false, isError: false, error: null };
});

function renderPreferences() {
  // A fresh store: `currentUserAtom` starts null, as on a direct load with nothing stored.
  return render(
    <Provider store={createStore()}>
      <MantineProvider>
        <UserProvider>
          <PageWidthPref />
          <NotificationPref />
        </UserProvider>
      </MantineProvider>
    </Provider>,
  );
}

describe("UserProvider (#911)", () => {
  it("renders no children while the current user is loading", () => {
    query.state = { data: undefined, isLoading: true, isError: false, error: null };
    renderPreferences();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
  });

  it("direct load with no stored user: children render once the user is stored, seeded from it", async () => {
    renderPreferences();
    const fullWidth = await screen.findByRole("switch", {
      name: "Toggle full page width",
    });
    expect((fullWidth as HTMLInputElement).checked).toBe(true);
    const pageUpdates = screen.getByRole("switch", { name: "Page updates" });
    expect((pageUpdates as HTMLInputElement).checked).toBe(false);
  });
});
