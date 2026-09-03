import { describe, it, expect } from "vitest";
import { resolvePageEditMode } from "./resolve-page-edit-mode";
import { PageEditMode } from "@/features/user/types/user.types.ts";

describe("resolvePageEditMode — precedence: user pref > workspace default > Read", () => {
  it("an explicit user Edit preference wins over everything", () => {
    expect(resolvePageEditMode(PageEditMode.Edit, PageEditMode.Read)).toBe(
      PageEditMode.Edit,
    );
    expect(resolvePageEditMode(PageEditMode.Edit, undefined)).toBe(
      PageEditMode.Edit,
    );
  });

  it("an explicit user Read preference wins over a workspace Edit default", () => {
    expect(resolvePageEditMode(PageEditMode.Read, PageEditMode.Edit)).toBe(
      PageEditMode.Read,
    );
  });

  it("falls to the workspace default when the user has no preference", () => {
    expect(resolvePageEditMode(undefined, PageEditMode.Edit)).toBe(
      PageEditMode.Edit,
    );
    expect(resolvePageEditMode(null, PageEditMode.Read)).toBe(PageEditMode.Read);
  });

  it("falls to READ when neither user nor workspace has chosen (the safe default)", () => {
    expect(resolvePageEditMode(undefined, undefined)).toBe(PageEditMode.Read);
    expect(resolvePageEditMode(null, null)).toBe(PageEditMode.Read);
  });

  it("ignores unrecognized values and falls through to Read", () => {
    expect(resolvePageEditMode("garbage", "also-bad")).toBe(PageEditMode.Read);
    expect(resolvePageEditMode("", "")).toBe(PageEditMode.Read);
  });
});
