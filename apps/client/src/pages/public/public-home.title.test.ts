import { describe, it, expect } from "vitest";
import { publicHomeTitle } from "./public-home";

describe("publicHomeTitle — the public landing's document title", () => {
  it("composes '<workspace> — <app>' when the names differ", () => {
    expect(publicHomeTitle("CCC Wiki CI", "CCC Wiki")).toBe(
      "CCC Wiki CI — CCC Wiki",
    );
  });

  it("collapses to the bare app name when the workspace name equals it (prod: workspace == brand)", () => {
    expect(publicHomeTitle("CCC Wiki", "CCC Wiki")).toBe("CCC Wiki");
  });

  it("is the bare app name when no workspace data has loaded", () => {
    expect(publicHomeTitle(undefined, "Wiki")).toBe("Wiki");
  });
});
