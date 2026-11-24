import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { Provider, createStore } from "jotai";
import { RESET } from "jotai/utils";

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
// The real page needs a Router and a HelmetProvider; a marker is enough to pin the 404 branch.
vi.mock("@/components/ui/error-404.tsx", () => ({
  Error404: () => <div data-testid="e404" />,
}));

import { UserProvider } from "./user-provider";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";
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

const realLocation = window.location;
const location = vi.hoisted(() => ({
  replace: vi.fn(),
}));

beforeEach(() => {
  window.localStorage?.removeItem("currentUser");
  query.state = { data: loaded, isLoading: false, isError: false, error: null };
  location.replace.mockReset();
  Object.defineProperty(window, "location", {
    value: {
      origin: "http://localhost",
      pathname: "/p/abc",
      search: "",
      replace: location.replace,
    },
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
  vi.restoreAllMocks();
});

function renderPreferences(store = createStore()) {
  // By default a fresh store: `currentUserAtom` starts null, as on a direct load with nothing stored.
  const view = render(
    <Provider store={store}>
      <MantineProvider>
        <UserProvider>
          <PageWidthPref />
          <NotificationPref />
        </UserProvider>
      </MantineProvider>
    </Provider>,
  );
  return { ...view, store };
}

// What another tab's sign-out looks like here: the browser fires `storage` only in OTHER documents.
function otherTabCleared(key: string | null = "currentUser") {
  window.dispatchEvent(
    new StorageEvent("storage", {
      key,
      newValue: null,
      storageArea: window.localStorage,
    }),
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

  it("404 from /users/me renders the not-found page and no children", () => {
    query.state = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: { response: { status: 404 } },
    };
    renderPreferences();
    expect(screen.getByTestId("e404")).toBeTruthy();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
  });
});

describe("UserProvider (#917)", () => {
  it("RESET after load unmounts the children and throws nothing", async () => {
    const { store } = renderPreferences();
    await screen.findByRole("switch", { name: "Toggle full page width" });
    act(() => store.set(currentUserAtom, RESET));
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.queryByTestId("e404")).toBeNull();
  });

  it("a same-tab RESET does not redirect (the logout POSTs must not be aborted)", async () => {
    const { store } = renderPreferences();
    await screen.findByRole("switch", { name: "Toggle full page width" });
    act(() => store.set(currentUserAtom, RESET));
    expect(location.replace).not.toHaveBeenCalled();
  });

  it.each([
    ["the key is removed", "currentUser"],
    ["storage is cleared", null],
  ])(
    "another tab signs out (%s): this tab goes to login, returning here",
    async (_label, key) => {
      renderPreferences();
      await screen.findByRole("switch", { name: "Toggle full page width" });
      act(() => otherTabCleared(key));
      expect(location.replace).toHaveBeenCalledTimes(1);
      expect(location.replace).toHaveBeenCalledWith(
        "/login?redirect=%2Fp%2Fabc",
      );
    },
  );

  it("another tab's clear before this load stored a user does not redirect", () => {
    query.state = { data: undefined, isLoading: true, isError: false, error: null };
    renderPreferences();
    act(() => otherTabCleared());
    expect(location.replace).not.toHaveBeenCalled();
  });

  it("another tab storing a user (its own load) does not redirect", async () => {
    renderPreferences();
    await screen.findByRole("switch", { name: "Toggle full page width" });
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "currentUser",
          newValue: JSON.stringify(loaded),
          storageArea: window.localStorage,
        }),
      );
    });
    expect(location.replace).not.toHaveBeenCalled();
  });

  it("an unrelated storage key changing does not redirect", async () => {
    renderPreferences();
    await screen.findByRole("switch", { name: "Toggle full page width" });
    act(() => otherTabCleared("something-else"));
    expect(location.replace).not.toHaveBeenCalled();
  });

  it("a stale stored user never seeds the children: they render from this load's user", async () => {
    const store = createStore();
    // A previous session's copy (another person, or older settings), opposite to `loaded` on both toggles.
    store.set(currentUserAtom, {
      user: {
        id: "u0",
        settings: {
          preferences: { fullPageWidth: false },
          notifications: { "page.updated": true },
        },
      },
      workspace: { id: "w1" },
    } as never);
    renderPreferences(store);
    const fullWidth = await screen.findByRole("switch", {
      name: "Toggle full page width",
    });
    expect((fullWidth as HTMLInputElement).checked).toBe(true);
    const pageUpdates = screen.getByRole("switch", { name: "Page updates" });
    expect((pageUpdates as HTMLInputElement).checked).toBe(false);
  });

  it("malformed /users/me (no workspace) warns once and renders no children", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    query.state = {
      data: { user: loaded.user, workspace: undefined },
      isLoading: false,
      isError: false,
      error: null,
    };
    renderPreferences();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
  });
});
