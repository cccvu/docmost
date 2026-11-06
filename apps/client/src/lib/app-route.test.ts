import { afterEach, describe, expect, it } from "vitest";
import { getPostLoginRedirect, safeRedirectPath } from "./app-route";

// wiki-v2 #713 — NOT upstream Docmost code. `safeRedirectPath` guards `/login?redirect=` (getPostLoginRedirect) and
// the step-up return path. It must answer only a same-origin, root-relative path, including after the URL parser
// normalizes dot segments (which can turn a harmless-looking path into the protocol-relative "//evil.com").
describe("safeRedirectPath", () => {
  it.each([
    ["/s/eng/p/abc?q=1#h", "/s/eng/p/abc?q=1#h"],
    ["/home", "/home"],
    ["/a/../b", "/b"],
    ["/%2F%2Fevil.com", "/%2F%2Fevil.com"], // an encoded slash stays a segment on this origin
  ])("keeps the same-origin path %s", (raw, expected) => {
    expect(safeRedirectPath(raw)).toBe(expected);
  });

  it.each([
    ["//evil.com"],
    ["/\\evil.com"],
    ["https://evil.com"],
    ["javascript:alert(1)"],
    ["evil.com"],
    [""],
    [null],
    // dot segments that pass the raw checks but NORMALIZE to "//evil.com"
    ["/.//evil.com"],
    ["/..//evil.com"],
    ["/%2e//evil.com"],
    ["/%2e%2e//evil.com"],
    ["/a/..//evil.com"],
    ["/a/b/../..//evil.com/x?y=1"],
  ])("refuses %j", (raw) => {
    expect(safeRedirectPath(raw)).toBeNull();
  });
});

describe("getPostLoginRedirect", () => {
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("falls back to home for a ?redirect= that normalizes off-origin", () => {
    window.history.replaceState(null, "", `/login?redirect=${encodeURIComponent("/..//evil.com")}`);
    expect(getPostLoginRedirect()).toBe("/home");
  });

  it("keeps a safe ?redirect=", () => {
    window.history.replaceState(null, "", `/login?redirect=${encodeURIComponent("/s/eng")}`);
    expect(getPostLoginRedirect()).toBe("/s/eng");
  });
});
