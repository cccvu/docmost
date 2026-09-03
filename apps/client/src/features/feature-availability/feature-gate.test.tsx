import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, renderHook, screen, cleanup } from "@testing-library/react";

// Drive the gate off the entitlement predicate directly — that is the behavior the
// gate depends on, and it avoids fighting the atomWithStorage/localStorage sync in
// jsdom. `available` is the set of entitled features for the current test.
const { available } = vi.hoisted(() => ({ available: new Set<string>() }));
vi.mock("@/ee/hooks/use-feature", () => ({
  useHasFeature: (f: string) => available.has(f),
}));

import { FeatureGate, useFeatureAvailable } from "./feature-gate";

beforeEach(() => available.clear());
afterEach(() => cleanup());

describe("useFeatureAvailable", () => {
  it("is true when the feature is entitled", () => {
    available.add("templates");
    const { result } = renderHook(() => useFeatureAvailable("templates"));
    expect(result.current).toBe(true);
  });

  it("is false when the feature is not entitled", () => {
    const { result } = renderHook(() => useFeatureAvailable("templates"));
    expect(result.current).toBe(false);
  });
});

describe("FeatureGate — hide, don't advertise", () => {
  it("renders children when the feature is available", () => {
    available.add("templates");
    render(
      <FeatureGate feature="templates">
        <div>Gated content</div>
      </FeatureGate>,
    );
    expect(screen.queryByText("Gated content")).not.toBeNull();
  });

  it("hides children when the feature is unavailable", () => {
    render(
      <FeatureGate feature="templates">
        <div>Gated content</div>
      </FeatureGate>,
    );
    expect(screen.queryByText("Gated content")).toBeNull();
  });

  it("renders the fallback (not the children) when unavailable", () => {
    render(
      <FeatureGate feature="templates" fallback={<div>Fallback</div>}>
        <div>Gated content</div>
      </FeatureGate>,
    );
    expect(screen.queryByText("Fallback")).not.toBeNull();
    expect(screen.queryByText("Gated content")).toBeNull();
  });
});
