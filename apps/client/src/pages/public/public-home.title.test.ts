import { describe, it, expect } from "vitest";
import { publicHomeTitle } from "./public-home";

describe("publicHomeTitle — the public landing's document title", () => {
  it("composes '<workspace> — <app>' when the names differ", () => {
    expect(publicHomeTitle("Example Workspace", "Example Wiki")).toBe(
      "Example Workspace — Example Wiki",
    );
  });

  it("collapses to the bare app name when the workspace name equals it", () => {
    expect(publicHomeTitle("Example Wiki", "Example Wiki")).toBe(
      "Example Wiki",
    );
  });

  it("is the bare app name when no workspace data has loaded", () => {
    expect(publicHomeTitle(undefined, "Wiki")).toBe("Wiki");
  });
});
