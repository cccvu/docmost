import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, renderHook, screen, cleanup } from "@testing-library/react";

// Drive the gate off the entitlement predicate directly — that is the behavior the
// gate depends on, and it avoids fighting the atomWithStorage/localStorage sync in
// jsdom. `available` is the set of entitled features for the current test.
const { available } = vi.hoisted(() => ({ available: new Set<string>() }));
vi.mock("@/ee/hooks/use-feature", () => ({
  useHasFeature: (f: string) => available.has(f),
}));

// The workspace the AI chat gate reads (#858). A plain derived atom; each renderHook gets a fresh jotai store.
const ws = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/features/user/atoms/current-user-atom", async () => {
  const { atom } = await import("jotai");
  return { workspaceAtom: atom(() => ws.value) };
});

import React from "react";
import { Provider } from "jotai";
import {
  FeatureGate,
  useAiChatAvailable,
  useCommentResolutionAvailable,
  useFeatureAvailable,
} from "./feature-gate";

function freshStore({ children }: { children: React.ReactNode }) {
  return <Provider>{children}</Provider>;
}

beforeEach(() => {
  available.clear();
  ws.value = null;
});
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

describe("useAiChatAvailable (#858)", () => {
  const chatOn = { settings: { ai: { chat: true } } };

  function aiChat() {
    return renderHook(() => useAiChatAvailable(), { wrapper: freshStore })
      .result.current;
  }

  it("is false when the workspace flag is on but the AI feature is not entitled", () => {
    // The server stores `ai.chat` with no licence check, while /ai is never registered here.
    ws.value = chatOn;
    expect(aiChat()).toBe(false);
  });

  it("is false when the AI feature is entitled but the workspace flag is off or absent", () => {
    available.add("ai");
    ws.value = { settings: { ai: { chat: false } } };
    expect(aiChat()).toBe(false);
    ws.value = { settings: {} };
    expect(aiChat()).toBe(false);
    ws.value = null;
    expect(aiChat()).toBe(false);
  });

  it("is true only with the entitlement AND the flag", () => {
    available.add("ai");
    ws.value = chatOn;
    expect(aiChat()).toBe(true);
  });
});

describe("useCommentResolutionAvailable (#858)", () => {
  it("is true without the upstream comment:resolution entitlement (the fork serves the route in both modes)", () => {
    const { result } = renderHook(() => useCommentResolutionAvailable());
    expect(available.has("comment:resolution")).toBe(false);
    expect(result.current).toBe(true);
  });
});
