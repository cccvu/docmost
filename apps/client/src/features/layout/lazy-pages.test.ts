import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import * as lazyPages from "./lazy-pages";

// The Bases grid (@tanstack/react-table + src/ee/base) resolves only when the test says so.
const deferredBaseView = vi.hoisted(() => {
  let resolve!: (mod: unknown) => void;
  const promise = new Promise<unknown>((r) => (resolve = r));
  return { promise, resolve };
});
vi.mock("@/ee/base/components/base-view", () => deferredBaseView.promise);

// Pinned, ASCII-sorted. Adding an eager import back to App.tsx (dropping one here) or
// lazy-loading a route this file doesn't own must show up as a diff to this list.
const EXPECTED_LAZY_ROUTES = [
  "AccountPreferences",
  "AccountSettings",
  "AiChat",
  "AiSettings",
  "AuditLogs",
  "BasePage",
  "Billing",
  "CloudLogin",
  "CreateWorkspace",
  "GroupInfo",
  "Groups",
  "InviteSignup",
  "License",
  "MfaChallengePage",
  "MfaSetupRequiredPage",
  "PdfRenderPage",
  "Security",
  "SetupWorkspace",
  "ShareLayout",
  "ShareRedirect",
  "SharedPage",
  "Shares",
  "SpaceTrash",
  "Spaces",
  "TemplateEditor",
  "TemplateList",
  "UserApiKeys",
  "VerifiedPages",
  "VerifyEmail",
  "WorkspaceApiKeys",
  "WorkspaceMembers",
  "WorkspaceSettings",
];

// Plain components that wrap a lazy() in <Suspense> for a NON-route consumer (page.tsx renders
// BaseView directly, outside <Routes>). Not react.lazy themselves — pinned separately.
const EXPECTED_LAZY_WRAPPERS = ["BaseView"];

const EXPECTED_EXPORTS = [...EXPECTED_LAZY_ROUTES, ...EXPECTED_LAZY_WRAPPERS].sort();

// The primary cold-load path stays eager on purpose; these must never appear here.
const MUST_STAY_EAGER = [
  "RootGate",
  "PasswordlessLogin",
  "PasswordlessVerify",
  "NativeLogin",
  "Home",
  "Page",
  "SpaceHome",
  "PageRedirect",
  "Layout",
  "SpacesPage",
  "FavoritesPage",
  "LabelPage",
  "Error404",
];

describe("lazy-pages (issue #309)", () => {
  it("pins the exact set of rarely-visited route components + lazy wrappers", () => {
    expect([...EXPECTED_LAZY_ROUTES].sort()).toEqual(EXPECTED_LAZY_ROUTES);
    expect(Object.keys(lazyPages).sort()).toEqual(EXPECTED_EXPORTS);
  });

  it("exports every route as a React.lazy component (loaded on demand)", () => {
    for (const name of EXPECTED_LAZY_ROUTES) {
      const component = (lazyPages as Record<string, unknown>)[name] as
        | { $$typeof?: symbol }
        | undefined;
      expect(component?.$$typeof, name).toBe(Symbol.for("react.lazy"));
    }
  });

  it("never lazy-loads the primary cold-load path", () => {
    for (const name of MUST_STAY_EAGER) {
      expect(name in lazyPages, name).toBe(false);
    }
  });

  it("BaseView is a plain Suspense wrapper (a component, not a react.lazy)", () => {
    expect(typeof lazyPages.BaseView).toBe("function");
    expect((lazyPages.BaseView as { $$typeof?: symbol }).$$typeof).toBeUndefined();
  });

  it("BaseView renders nothing until the Bases chunk resolves, then the real view", async () => {
    const { container } = render(
      createElement(lazyPages.BaseView, { pageId: "page-1", editable: false }),
    );
    expect(container.innerHTML).toBe("");

    deferredBaseView.resolve({
      BaseView: (props: { pageId: string; editable?: boolean }) =>
        createElement(
          "div",
          { "data-testid": "real-base-view" },
          `base:${props.pageId}:${String(props.editable)}`,
        ),
    });

    const real = await screen.findByTestId("real-base-view");
    expect(real.textContent).toBe("base:page-1:false");
  });
});
