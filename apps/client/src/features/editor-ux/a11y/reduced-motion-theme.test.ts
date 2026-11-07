// #145: Mantine transitions (Menu/Popover/Modal, incl. every editor toolbar menu) must honour the OS
// "reduce motion" setting. `respectReducedMotion` defaults to false in Mantine, so the app theme opts in.
import { describe, it, expect } from "vitest";
import { theme } from "@/theme";

describe("app theme", () => {
  it("respects prefers-reduced-motion", () => {
    expect(theme.respectReducedMotion).toBe(true);
  });
});
