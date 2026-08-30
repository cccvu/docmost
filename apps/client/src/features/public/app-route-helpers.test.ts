import { describe, it, expect } from "vitest";
import APP_ROUTE, {
  isPublicRoutePath,
  loginHrefWithReturn,
} from "@/lib/app-route";

describe("isPublicRoutePath — the single source of truth for the login-wall exemption", () => {
  it.each([
    ["/", true],
    ["/request-access", true],
    ["/request-access/step", true],
    ["/home", false],
    ["/share/abc/p/xyz", false],
    ["/s/space/p/page", false],
    ["/login", false],
    ["/settings/members", false],
  ])("%s -> %s", (path, expected) => {
    expect(isPublicRoutePath(path as string)).toBe(expected);
  });
});

describe("loginHrefWithReturn — carries the visitor back after login", () => {
  const setLocation = (path: string) => window.history.pushState({}, "", path);

  it("returns bare /login from the root (re-gates to /home anyway)", () => {
    setLocation("/");
    expect(loginHrefWithReturn()).toBe(APP_ROUTE.AUTH.LOGIN);
  });

  it("returns bare /login from /home", () => {
    setLocation("/home");
    expect(loginHrefWithReturn()).toBe(APP_ROUTE.AUTH.LOGIN);
  });

  it("carries a same-origin redirect back to a public share page", () => {
    setLocation("/share/abc/p/xyz");
    const href = loginHrefWithReturn();
    expect(href.startsWith("/login?redirect=")).toBe(true);
    expect(decodeURIComponent(href)).toContain("/share/abc/p/xyz");
  });
});
