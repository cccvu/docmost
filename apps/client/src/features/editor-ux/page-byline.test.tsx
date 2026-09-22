import { describe, it, expect, beforeAll, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

// The byline lives in an upstream-authored component (full-editor.tsx). We keep
// it there (modify-upstream-minimally) and test the exported PageByline in
// isolation, mocking full-editor's heavy editor siblings so importing the module
// stays cheap and side-effect-free in jsdom.
vi.mock("@/features/editor/title-editor", () => ({ TitleEditor: () => null }));
vi.mock("@/features/editor/page-editor", () => ({ default: () => null }));
vi.mock("@/features/editor/components/fixed-toolbar/fixed-toolbar", () => ({
  FixedToolbar: () => null,
}));
vi.mock("@/features/page/trash/components/deleted-page-banner.tsx", () => ({
  DeletedPageBanner: () => null,
}));
vi.mock("@/features/editor/components/empty-page/empty-page-get-started", () => ({
  EmptyPageGetStarted: () => null,
}));
// EE badge + the aside-toggle hook (jotai) aren't under test here.
vi.mock("@/ee/page-verification", () => ({ PageVerificationBadge: () => null }));
vi.mock("@/hooks/use-toggle-aside.tsx", () => ({
  useAsideTriggerProps: () => ({
    onClick: () => {},
    "aria-expanded": false,
    "aria-controls": "aside-panel",
  }),
}));
// Real i18n isn't loaded in unit tests; interpolate {{name}} so assertions see
// the composed byline text exactly as a user would.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      key.replace(/{{(\w+)}}/g, (_m, p1) => String(opts?.[p1] ?? "")),
  }),
}));

import { PageByline } from "@/features/editor/full-editor";

// Mantine's Popover needs matchMedia + ResizeObserver in jsdom.
beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
  if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
      ResizeObserverStub;
    (window as unknown as { ResizeObserver?: unknown }).ResizeObserver =
      ResizeObserverStub;
  }
});

const creator = { id: "u-creator", name: "Bob Creator", avatarUrl: "" };
const editor = { id: "u-editor", name: "Alice Editor", avatarUrl: "" };
// 2026-09-17T20:48:00Z → 15:48 America/Chicago (CDT).
const UPDATED_AT = new Date("2026-09-17T20:48:00Z");

function renderByline(props: Parameters<typeof PageByline>[0]) {
  return render(
    <MantineProvider>
      <PageByline {...props} />
    </MantineProvider>,
  );
}

describe("PageByline", () => {
  it("names the LAST EDITOR (not the creator) plus when", () => {
    renderByline({ creator, lastUpdatedBy: editor, updatedAt: UPDATED_AT });
    // The byline reports the last editor + an absolute Central-Time stamp.
    expect(
      screen.getByText(/Updated by Alice Editor · .*3:48.*PM.*CDT/),
    ).toBeTruthy();
    // The creator is NOT the byline subject.
    expect(screen.queryByText(/Updated by Bob Creator/)).toBeNull();
  });

  it("exposes the timestamp in the trigger's accessible name (WCAG 2.5.3)", () => {
    renderByline({ creator, lastUpdatedBy: editor, updatedAt: UPDATED_AT });
    const trigger = screen.getByRole("button", {
      name: /Updated by Alice Editor · .*3:48.*PM.*CDT/,
    });
    expect(trigger).toBeTruthy();
  });

  it("falls back to the creator when the page was never edited", () => {
    renderByline({ creator, lastUpdatedBy: undefined, updatedAt: UPDATED_AT });
    expect(screen.getByText(/Updated by Bob Creator/)).toBeTruthy();
  });

  it("omits the ' · when' separator when updatedAt is absent", () => {
    renderByline({ creator, lastUpdatedBy: editor, updatedAt: undefined });
    expect(screen.getByText("Updated by Alice Editor")).toBeTruthy();
    expect(screen.queryByText(/·/)).toBeNull();
  });

  it("renders no byline trigger when neither creator nor last editor exist", () => {
    renderByline({
      creator: undefined,
      lastUpdatedBy: undefined,
      updatedAt: UPDATED_AT,
    });
    expect(screen.queryByText(/Updated by/)).toBeNull();
  });
});
