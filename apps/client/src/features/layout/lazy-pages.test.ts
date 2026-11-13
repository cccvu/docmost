import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { render, screen } from "@testing-library/react";
import * as lazyPages from "./lazy-pages";
import { isEnterpriseLoginEnabled } from "@/features/auth-native/lib/enterprise-login";

const readSource = (relativeToThisFile: string): string =>
  readFileSync(fileURLToPath(new URL(relativeToThisFile, import.meta.url)), "utf8");

// The Bases grid (@tanstack/react-table + src/ee/base) resolves only when the test says so.
const deferredBaseView = vi.hoisted(() => {
  let resolve!: (mod: unknown) => void;
  const promise = new Promise<unknown>((r) => (resolve = r));
  return { promise, resolve };
});
vi.mock("@/ee/base/components/base-view", () => deferredBaseView.promise);

// Pinned, ASCII-sorted: the exact export surface of lazy-pages.ts. This catches a route being added to
// or dropped from the lazy set. It cannot see App.tsx: a static re-import of a lazied module there
// (which would silently put the chunk back on the eager graph while the export stays) is caught by the
// App.tsx source pin further down, not by this list.
const EXPECTED_LAZY_ROUTES = [
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

// wiki-v2 UI cleanup: EE pages that are no longer routed in either mode (ADR 0035). Their ee/ sources
// stay, but a lazy export would be a route nobody can reach; App.tsx's 404 for them is pinned in
// app-routes.test.tsx.
const REMOVED_EE_ROUTES = [
  "AiChat",
  "AiSettings",
  "AuditLogs",
  "BasePage",
  "License",
  "PdfRenderPage",
  "Security",
  "TemplateEditor",
  "TemplateList",
  "UserApiKeys",
  "VerifiedPages",
  "WorkspaceApiKeys",
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

  it("wiki-v2 UI cleanup: exports none of the unrouted EE pages", () => {
    for (const name of REMOVED_EE_ROUTES) {
      expect(name in lazyPages, name).toBe(false);
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

  // ---- source-level pins ----------------------------------------------------------------------
  // Every lazy this branch introduced must carry chunk-load recovery (lazy-with-reload.ts): a bare
  // React.lazy caches a post-deploy chunk rejection for the life of the document and blanks the app.
  const LAZY_SOURCES = [
    "./lazy-pages.ts",
    "../editor-ux/lazy/base-embed-view-lazy.tsx",
    "../editor-ux/lazy/math-block-lazy.tsx",
    "../editor-ux/lazy/math-inline-lazy.tsx",
    "../analytics/posthog-analytics.tsx",
  ];

  it.each(LAZY_SOURCES)("%s goes through lazyWithReload, never a bare lazy()", (file) => {
    const source = readSource(file);
    expect(source, file).toContain("lazyWithReload(");
    expect(source, `${file} calls React.lazy directly`).not.toMatch(/\blazy\(/);
  });

  it("App.tsx does not statically re-import a module lazy-pages.ts lazies", () => {
    // What lazy-pages.ts defers…
    const lazied = [...readSource("./lazy-pages.ts").matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)]
      .map((m) => m[1]);
    expect(lazied.length).toBeGreaterThanOrEqual(EXPECTED_LAZY_ROUTES.length);

    // …must not be on App.tsx's static graph (type-only imports are erased and do not count).
    const app = readSource("../../App.tsx");
    const staticImports = [
      ...[...app.matchAll(/^\s*import\s+(?!type\b)[^;]*?\bfrom\s+["']([^"']+)["']/gm)].map(
        (m) => m[1],
      ),
      ...[...app.matchAll(/^\s*import\s+["']([^"']+)["']/gm)].map((m) => m[1]),
    ];
    expect(staticImports.length).toBeGreaterThan(0);

    // App.tsx lives at src/App.tsx, so "./x" there is the same module as "@/x".
    const normalize = (spec: string) =>
      spec.replace(/^\.\//, "@/").replace(/\.tsx?$/, "");
    const eager = new Set(staticImports.map(normalize));
    const collisions = lazied.map(normalize).filter((spec) => eager.has(spec));
    expect(collisions).toEqual([]);
  });

  // CCC #133 (ADR 0035): EE MFA login is unsupported, so the /login/mfa routes are registered only
  // inside the isEnterpriseLoginEnabled() gate (false in every mode). The lazy exports stay pinned above.
  it("App.tsx registers the /login/mfa routes only inside the isEnterpriseLoginEnabled() gate", () => {
    const app = readSource("../../App.tsx");
    expect(app).toMatch(
      /^import\s*\{\s*isEnterpriseLoginEnabled\s*\}\s*from\s*["']@\/features\/auth-native\/lib\/enterprise-login(\.ts)?["'];/m,
    );

    const MFA_ROUTE = /path=\{\s*["']\/login\/mfa[^"']*["']\s*\}/g;
    const gateStart = app.indexOf("{isEnterpriseLoginEnabled() && (");
    expect(gateStart, "isEnterpriseLoginEnabled() route gate").not.toBe(-1);

    // The gate's extent: from its "(" to the matching ")".
    const open = app.indexOf("(", app.indexOf("&&", gateStart));
    let depth = 0;
    let close = -1;
    for (let i = open; i < app.length; i++) {
      if (app[i] === "(") depth++;
      else if (app[i] === ")" && --depth === 0) {
        close = i;
        break;
      }
    }
    expect(close).toBeGreaterThan(open);

    const gated = app.slice(open, close);
    const outside = app.slice(0, gateStart) + app.slice(close);
    expect(gated.match(MFA_ROUTE)?.length ?? 0).toBe(2);
    expect(outside.match(MFA_ROUTE) ?? []).toEqual([]);
    // …and the gate is closed.
    expect(isEnterpriseLoginEnabled()).toBe(false);
  });
});
