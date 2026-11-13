// wiki-v2 UI cleanup: the route table in App.tsx (upstream seam #6), rendered for real through a
// MemoryRouter with every page stubbed to a marker. Pins that the native directory screens (members,
// groups, invite sign-up) are registered in native mode only, that the platform's public pages (magic-link
// landing, request access) are registered in remote mode only, and that the never-entitled EE routes
// (ADR 0035) fall to Error404 in both modes. Hiding a route is UX: the server refuses these APIs itself.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const nativeState = vi.hoisted(() => ({ value: false }));
vi.mock("@/features/auth-native/lib/auth-mode.ts", () => ({
  isNativeAuthEnabled: () => nativeState.value,
}));
vi.mock("@/lib/config.ts", async (orig) => ({
  ...(await orig<object>()),
  isCloud: () => false,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("@/ee/hooks/use-redirect-to-cloud-select.tsx", () => ({
  useRedirectToCloudSelect: () => {},
}));
vi.mock("@/hooks/use-track-origin", () => ({ useTrackOrigin: () => {} }));

// Every page is a marker naming itself. The lazy-pages mock lists only the names App.tsx may import:
// vitest fails the import of any other name, so re-importing a removed EE page reds this file too.
// A component that returns a string renders a bare text node: no JSX inside the hoisted factories.
const marker = vi.hoisted(() => (name: string) => ({ default: () => `page:${name}` }));
vi.mock("@/features/layout/lazy-pages", () => {
  const names = [
    "AccountPreferences",
    "AccountSettings",
    "Billing",
    "CloudLogin",
    "CreateWorkspace",
    "GroupInfo",
    "Groups",
    "InviteSignup",
    "MfaChallengePage",
    "MfaSetupRequiredPage",
    "SetupWorkspace",
    "ShareLayout",
    "ShareRedirect",
    "SharedPage",
    "Shares",
    "SpaceTrash",
    "Spaces",
    "VerifyEmail",
    "WorkspaceMembers",
    "WorkspaceSettings",
  ];
  return Object.fromEntries(
    names.map((n) => [n, marker(n).default]),
  );
});
vi.mock("@/components/layouts/global/layout.tsx", async () => {
  const { createElement } = await import("react");
  const { Outlet } = await import("react-router-dom");
  return { default: () => createElement(Outlet) };
});
vi.mock("@/components/ui/error-404.tsx", () => ({ Error404: marker("Error404").default }));
vi.mock("@/features/public/components/root-gate.tsx", () => marker("RootGate"));
vi.mock("@/pages/public/request-access.tsx", () => marker("RequestAccess"));
vi.mock("@/pages/public/passwordless-login.tsx", () => marker("PasswordlessLogin"));
vi.mock("@/pages/public/passwordless-verify.tsx", () => marker("PasswordlessVerify"));
vi.mock("@/features/auth-native/pages/native-login.tsx", () => marker("NativeLogin"));
vi.mock("@/pages/dashboard/home", () => marker("Home"));
vi.mock("@/pages/page/page", () => marker("Page"));
vi.mock("@/pages/space/space-home.tsx", () => marker("SpaceHome"));
vi.mock("@/pages/page/page-redirect.tsx", () => marker("PageRedirect"));
vi.mock("@/pages/spaces/spaces.tsx", () => marker("SpacesPage"));
vi.mock("@/pages/favorites/favorites-page", () => marker("FavoritesPage"));
vi.mock("@/pages/label/label-page", () => marker("LabelPage"));

import App from "@/App";

beforeEach(() => {
  nativeState.value = false;
});
afterEach(cleanup);

async function pageAt(path: string): Promise<string> {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
  const el = await screen.findByText(/^page:/);
  return el.textContent ?? "";
}

const DIRECTORY_ROUTES: Array<[string, string]> = [
  ["/settings/members", "WorkspaceMembers"],
  ["/settings/groups", "Groups"],
  ["/settings/groups/3f2c0a4e-1b2d-4c5e-8f9a-0b1c2d3e4f5a", "GroupInfo"],
  ["/invites/9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a", "InviteSignup"],
];

// The platform's own public pages: native (standalone) mode has no platform to post to.
const PLATFORM_ROUTES: Array<[string, string]> = [
  ["/login/verify", "PasswordlessVerify"],
  ["/request-access", "RequestAccess"],
];

const REMOVED_EE_ROUTES = [
  "/settings/license",
  "/settings/account/api-keys",
  "/settings/api-keys",
  "/settings/verifications",
  "/settings/audit",
  "/settings/security",
  "/settings/ai",
  "/settings/ai/mcp",
  "/ai",
  "/ai/chat/0b6a6f8e-8d1c-4b8a-9c41-1f0c1a2b3c4d",
  "/templates",
  "/templates/0b6a6f8e-8d1c-4b8a-9c41-1f0c1a2b3c4d",
  "/base/0b6a6f8e-8d1c-4b8a-9c41-1f0c1a2b3c4d",
  "/pdf-render/0b6a6f8e-8d1c-4b8a-9c41-1f0c1a2b3c4d",
];

describe("App routes — native directory screens", () => {
  it.each(DIRECTORY_ROUTES)("remote mode: %s is not registered (Error404)", async (path) => {
    expect(await pageAt(path)).toBe("page:Error404");
  });

  it.each(DIRECTORY_ROUTES)("native mode: %s renders %s", async (path, page) => {
    nativeState.value = true;
    expect(await pageAt(path)).toBe(`page:${page}`);
  });
});

describe("App routes — platform-only public pages", () => {
  it.each(PLATFORM_ROUTES)("remote mode: %s renders %s", async (path, page) => {
    expect(await pageAt(path)).toBe(`page:${page}`);
  });

  it.each(PLATFORM_ROUTES)("native mode: %s is not registered (Error404)", async (path) => {
    nativeState.value = true;
    expect(await pageAt(path)).toBe("page:Error404");
  });
});

describe("App routes — EE routes are unregistered in both modes (ADR 0035)", () => {
  it.each(REMOVED_EE_ROUTES)("remote mode: %s is Error404", async (path) => {
    expect(await pageAt(path)).toBe("page:Error404");
  });

  it.each(REMOVED_EE_ROUTES)("native mode: %s is Error404", async (path) => {
    nativeState.value = true;
    expect(await pageAt(path)).toBe("page:Error404");
  });
});

describe("App routes — the routes this cleanup keeps", () => {
  const KEPT: Array<[string, string]> = [
    ["/home", "Home"],
    ["/settings/account/profile", "AccountSettings"],
    ["/settings/account/preferences", "AccountPreferences"],
    ["/settings/workspace", "WorkspaceSettings"],
    ["/settings/spaces", "Spaces"],
    ["/settings/sharing", "Shares"],
    ["/s/eng/trash", "SpaceTrash"],
  ];

  it.each(KEPT)("remote and native: %s renders %s", async (path, page) => {
    expect(await pageAt(path)).toBe(`page:${page}`);
    cleanup();
    nativeState.value = true;
    expect(await pageAt(path)).toBe(`page:${page}`);
  });
});
