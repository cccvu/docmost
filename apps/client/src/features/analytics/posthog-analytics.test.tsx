import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// Control the cloud/telemetry gate per test.
const isCloud = vi.fn(() => false);
const isPostHogEnabled = vi.fn(() => false);
vi.mock("@/lib/config.ts", () => ({
  isCloud: () => isCloud(),
  isPostHogEnabled: () => isPostHogEnabled(),
}));

// The lazy posthog-init chunk is spied so we can assert whether the runtime gate loads/initializes posthog.
// This proves the isCloud()/isPostHogEnabled() EFFECT gate (a self-hosted visitor never triggers the dynamic
// import); the separate "posthog-js is off the eager import graph" guarantee is enforced by the mustStayLazy
// budget lane (build/precompress.ts), not here.
const initPostHog = vi.fn();
vi.mock("./posthog-init.ts", () => ({ initPostHog }));

import { PostHogAnalytics } from "./posthog-analytics";

beforeEach(() => {
  isCloud.mockReturnValue(false);
  isPostHogEnabled.mockReturnValue(false);
  initPostHog.mockClear();
});

describe("PostHogAnalytics (issue #406)", () => {
  it("self-hosted: renders children and never loads posthog", async () => {
    render(
      <PostHogAnalytics>
        <div data-testid="child">app</div>
      </PostHogAnalytics>,
    );
    expect(screen.getByTestId("child").textContent).toBe("app");
    // Give any (unexpected) dynamic import a couple of microtask ticks to resolve.
    await Promise.resolve();
    await Promise.resolve();
    expect(initPostHog).not.toHaveBeenCalled();
  });

  it("cloud but telemetry not configured: renders children and does not initialize", async () => {
    isCloud.mockReturnValue(true);
    isPostHogEnabled.mockReturnValue(false);
    render(
      <PostHogAnalytics>
        <div data-testid="child">app</div>
      </PostHogAnalytics>,
    );
    expect(screen.getByTestId("child").textContent).toBe("app");
    await Promise.resolve();
    await Promise.resolve();
    expect(initPostHog).not.toHaveBeenCalled();
  });

  it("cloud + enabled: initializes posthog once without remounting children", async () => {
    isCloud.mockReturnValue(true);
    isPostHogEnabled.mockReturnValue(true);
    render(
      <PostHogAnalytics>
        <div data-testid="child">app</div>
      </PostHogAnalytics>,
    );
    // Children render immediately (never suspended/blank while posthog loads).
    const before = screen.getByTestId("child");
    expect(before.textContent).toBe("app");

    await waitFor(() => expect(initPostHog).toHaveBeenCalledTimes(1));

    // Same DOM node after init: the wrapper's element type never changes, so <App/> is not remounted (C1).
    expect(screen.getByTestId("child")).toBe(before);
  });
});
