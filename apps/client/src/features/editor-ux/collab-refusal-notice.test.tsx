import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import type { ComponentProps } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// cccvu/wiki-v2#781 — the notice an editor shows once the server refused one of its collab frames.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import {
  CollabPageNotices,
  CollabRefusalNotice,
} from "./collab-refusal-notice";
import { initialCollabAccess, nextCollabAccess } from "./collab-access";
import { COLLAB_LOCAL_COPY_RULE } from "./collab-refusal-cause";
import type { CollabAccessState, CollabRefusalKind } from "./collab-access";

beforeAll(() => {
  // Mantine's Modal needs matchMedia + ResizeObserver in jsdom.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

type NoticeProps = Omit<
  ComponentProps<typeof CollabRefusalNotice>,
  "clearLocalCopy" | "reload"
>;

function setup(
  clearLocalCopy: () => Promise<void> = async () => {},
  // #827: a refusal kind; `true`/`false` (the #781-lineage cases) mean too-big / generic
  kind: CollabRefusalKind | boolean = "generic",
  props: NoticeProps = {},
) {
  const calls: string[] = [];
  const clear = vi.fn(async () => {
    calls.push("clear");
    await clearLocalCopy();
  });
  const reload = vi.fn(() => calls.push("reload"));
  const view = (next: NoticeProps) => (
    <MantineProvider>
      <CollabRefusalNotice
        clearLocalCopy={clear}
        reload={reload}
        kind={kind === true ? "too-big" : kind === false ? "generic" : kind}
        {...next}
      />
    </MantineProvider>
  );
  const { rerender, unmount } = render(view(props));
  return {
    calls,
    clear,
    reload,
    unmount,
    rerender: (next: NoticeProps) => rerender(view(next)),
  };
}

const discardButton = () =>
  screen.getByRole("button", { name: "Discard this browser's copy" });

describe("CollabRefusalNotice", () => {
  it("is an alert that takes focus, so keyboard and screen-reader users reach it", () => {
    setup();
    const alert = screen.getByRole("alert");
    // the default (generic) cause says editing is paused, never that changes were lost (the incident's copy)
    expect(alert).toHaveProperty(
      "textContent",
      expect.stringContaining("Editing is paused on this page"),
    );
    expect(alert.textContent).not.toContain("Your latest changes were not saved");
    expect(alert.textContent).not.toContain("not saved");
    expect(document.activeElement).toBe(alert);
  });

  it("Reload reloads the page and clears nothing (a fresh client keeps this browser's copy)", () => {
    const { clear, reload } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(clear).not.toHaveBeenCalled();
  });

  it("Discard asks first and tells the user to copy what they need and close the page's other tabs", async () => {
    const { clear, reload } = setup();
    fireEvent.click(discardButton());
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("copy anything you need");
    expect(dialog.textContent).toContain("Close any other tabs of this page");
    expect(clear).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("confirming Discard clears this browser's copy, THEN reloads", async () => {
    const { calls } = setup();
    fireEvent.click(discardButton());
    await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Discard and reload" }),
      );
    });
    await waitFor(() => expect(calls).toEqual(["clear", "reload"]));
  });

  it("cancelling Discard clears and reloads nothing", async () => {
    const { clear, reload } = setup();
    fireEvent.click(discardButton());
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(clear).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("a failed clear does not reload (the reload would replay the same copy) and says so", async () => {
    const { calls } = setup(async () => {
      throw new Error("blocked");
    });
    fireEvent.click(discardButton());
    await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Discard and reload" }),
      );
    });
    await screen.findByText(
      "This browser's copy could not be cleared. Close the page's other tabs and try again.",
    );
    expect(calls).toEqual(["clear"]);
  });
});

// cccvu/wiki-v2#810 (review F1) — after a 1009 the oversized change is in this browser's copy, which a reload replays
// (and the server closes 1009 again), so only Discard recovers: the notice leads with it and offers no Reload.
describe("CollabRefusalNotice after a 1009 (too-big)", () => {
  it("says the change is too large, offers no Reload, and makes Discard the primary (filled) button", () => {
    setup(undefined, "too-big");
    expect(screen.getByRole("alert").textContent).toContain(
      "too large to send",
    );
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
    const discard = discardButton();
    expect(discard.getAttribute("data-variant")).toBe("filled");
  });

  it("Discard still asks first, then clears this browser's copy and reloads", async () => {
    const { calls } = setup(undefined, "too-big");
    fireEvent.click(discardButton());
    await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Discard and reload" }),
      );
    });
    await waitFor(() => expect(calls).toEqual(["clear", "reload"]));
  });

  it("a failed clear still does not reload", async () => {
    const { calls } = setup(async () => {
      throw new Error("blocked");
    }, "too-big");
    fireEvent.click(discardButton());
    await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Discard and reload" }),
      );
    });
    await screen.findByText(
      "This browser's copy could not be cleared. Close the page's other tabs and try again.",
    );
    expect(calls).toEqual(["clear"]);
  });

  // Anti-vacuity: every other refusal keeps Reload first and Discard secondary.
  it("generic: Reload is offered and Discard is not the primary button", () => {
    setup();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(discardButton().getAttribute("data-variant")).toBe("default");
    expect(screen.getByRole("alert").textContent).not.toContain(
      "too large to send",
    );
  });
});

// cccvu/wiki-v2#827 — the new refusals are Discard-first too (a reload replays the same copy); "compacted" opens the
// current version instead of reloading the old one.
describe("CollabRefusalNotice: the #827 kinds", () => {
  it.each([
    ["too-complex", "too complex for the server to apply"],
    ["page-full", "at its size limit"],
    ["compacted", "cannot be merged"],
  ] as [CollabRefusalKind, string][])(
    "%s says why, offers no Reload, and leads with Discard",
    (kind, text) => {
      setup(undefined, kind);
      expect(screen.getByRole("alert").textContent).toContain(text);
      expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
      const primary = screen.getByRole("button", {
        name:
          kind === "compacted"
            ? "Open the current version"
            : "Discard this browser's copy",
      });
      expect(primary.getAttribute("data-variant")).toBe("filled");
    },
  );

  it("compacted: Open the current version asks first, clears the old copy, THEN opens the current version", async () => {
    const { calls } = setup(undefined, "compacted");
    fireEvent.click(
      screen.getByRole("button", { name: "Open the current version" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("copy anything you need");
    expect(calls).toEqual([]);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: "Discard and open the current version",
        }),
      );
    });
    await waitFor(() => expect(calls).toEqual(["clear", "reload"]));
  });

  it("compacted: a failed clear opens nothing (the old copy could merge back)", async () => {
    const { calls } = setup(async () => {
      throw new Error("blocked");
    }, "compacted");
    fireEvent.click(
      screen.getByRole("button", { name: "Open the current version" }),
    );
    await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: "Discard and open the current version",
        }),
      );
    });
    await screen.findByText(
      "This browser's copy could not be cleared. Close the page's other tabs and try again.",
    );
    expect(calls).toEqual(["clear"]);
  });
});

describe("CollabPageNotices (#827)", () => {
  function show(
    access: Partial<CollabAccessState>,
    compactedTo: number | null = null,
    view: { passive?: boolean; showsLocalCopy?: boolean } = {},
  ) {
    const openCurrentVersion = vi.fn();
    const clearLocalCopy = vi.fn(async () => {});
    render(
      <MantineProvider>
        <CollabPageNotices
          access={{ ...initialCollabAccess, ...access }}
          epoch={{ compactedTo, openCurrentVersion }}
          clearLocalCopy={clearLocalCopy}
          {...view}
        />
      </MantineProvider>,
    );
    return { openCurrentVersion, clearLocalCopy };
  }

  it("shows nothing for a healthy editor", () => {
    show({});
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("compacting: a status banner (not an alert that steals focus) that says editing resumes on its own", () => {
    show({ compacting: true, tryLaterAttempts: 1 });
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("This page is being optimized");
    expect(status.textContent).toContain("resumes on its own");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a generic refusal's copy follows its rule's cause, and passive / showsLocalCopy reach the notice", () => {
    show({ refused: true, refusalKind: "generic", refusedRule: "root" });
    expect(screen.getByRole("alert").textContent).toContain("stored copy");
    cleanup();
    show({ refused: true, refusalKind: "generic", refusedRule: "schema" }, null, { passive: true });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("A change from this browser was not saved");
  });

  // #847: this browser's own copy broke (collab-copy-health.ts): the stored-copy notice, with both recoveries
  it("a broken local copy shows the stored-copy notice with Reload and a Discard that asks first", async () => {
    const access = nextCollabAccess(initialCollabAccess, { kind: "local-copy-broken" }).state;
    expect(access.refusedRule).toBe(COLLAB_LOCAL_COPY_RULE);
    const { clearLocalCopy } = show(access, null, { showsLocalCopy: false });
    const text = screen.getByRole("alert").textContent ?? "";
    expect(text).toContain(
      "This browser's stored copy of the page does not match the server",
    );
    expect(text).not.toContain("not saved");
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    fireEvent.click(discardButton());
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("cannot be recovered"); // the server's version is on screen
    expect(screen.getByRole("button", { name: "Discard and reload" })).toBeTruthy();
    expect(clearLocalCopy).not.toHaveBeenCalled(); // never discarded without the confirm
  });

  it("a refusal shows its kind's notice", () => {
    show({ refused: true, refusalKind: "page-full" });
    expect(screen.getByRole("alert").textContent).toContain(
      "at its size limit",
    );
  });

  // A clean copy is switching to the new epoch: a notice would flash and vanish.
  it("an epoch change shows nothing until the copy is known dirty", () => {
    show({ refused: true, refusalKind: "compacted", epochChangedTo: 2 });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a dirty copy's epoch change shows the compacted notice, whose Discard opens the current version", async () => {
    const { openCurrentVersion, clearLocalCopy } = show(
      { refused: true, refusalKind: "compacted", epochChangedTo: 2 },
      2,
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "cannot be merged",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open the current version" }),
    );
    await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: "Discard and open the current version",
        }),
      );
    });
    await waitFor(() => expect(openCurrentVersion).toHaveBeenCalledTimes(1));
    expect(clearLocalCopy).toHaveBeenCalledTimes(1);
  });
});

// The ledger-echo incident (#781 lineage): one red "Your latest changes were not saved" was shown for every rule, so a
// writer who had typed nothing was told their work was lost. The copy now follows the rule's cause.
describe("CollabRefusalNotice copy by cause", () => {
  const alertText = () => screen.getByRole("alert").textContent ?? "";
  const alertBox = () => screen.getByRole("alert");

  it("copy (the incident: a stored copy the server disagrees with) claims no lost change and keeps both recoveries", () => {
    setup(undefined, false, { cause: "copy" });
    expect(alertText()).not.toContain("not saved");
    expect(alertText()).not.toContain("Your");
    expect(alertText()).toContain("Editing is paused on this page");
    expect(alertText()).toContain("stored copy");
    expect(alertText()).toContain("other people's edits no longer appear here");
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(discardButton().getAttribute("data-variant")).toBe("default");
  });

  it("change (a change made here broke a rule) is the only cause that says a change was not saved", () => {
    setup(undefined, false, { cause: "change" });
    expect(alertText()).toContain("A change from this browser was not saved");
    expect(alertText()).toContain("other people's edits no longer appear here");
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(discardButton().getAttribute("data-variant")).toBe("default");
  });

  // Reload and Discard are the only ways out of a refused page, so every cause keeps both, in Edit and in Read mode alike;
  // only too big drops Reload (a reload would replay the oversized change).
  it("every cause, passive or not, offers Reload and a secondary Discard", () => {
    for (const cause of ["change", "copy", "other"] as const) {
      for (const passive of [false, true]) {
        const { unmount } = setup(undefined, false, { cause, passive });
        expect(screen.getAllByRole("button", { name: "Reload" })).toHaveLength(1);
        expect(discardButton().getAttribute("data-variant")).toBe("default");
        unmount();
      }
    }
  });

  it("other (the server could not decide, or a rule this bundle does not know) is generic", () => {
    setup(undefined, false, { cause: "other" });
    expect(alertText()).toContain("Editing is paused on this page");
    expect(alertText()).toContain("stopped syncing");
    expect(alertText()).not.toContain("not saved");
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(discardButton()).toBeTruthy();
  });

  it("too big keeps its own copy, says live edits stopped, and wins over any cause", () => {
    setup(undefined, true, { cause: "copy" });
    expect(alertText()).toContain("too large to send");
    expect(alertText()).toContain("A change from this browser was not saved");
    expect(alertText()).toContain("other people's edits no longer appear here");
  });

  // Anti-vacuity: each cause (and too big) renders its own text.
  it("every cause renders a distinct notice", () => {
    const texts = new Set<string>();
    for (const [tooBig, cause] of [
      [false, "change"],
      [false, "copy"],
      [false, "other"],
      [true, "other"],
    ] as const) {
      const { unmount } = setup(undefined, tooBig, { cause });
      texts.add(alertText());
      unmount();
    }
    expect(texts.size).toBe(4);
  });

  // Colour follows impact: red only when a change was not saved. The paused causes are blue, not yellow: Mantine's light
  // yellow alert title (yellow-9 on yellow-1) is about 2.7:1, under WCAG 1.4.3's 4.5:1 for its size.
  it("is red only for change and too big; the paused causes are blue, never yellow", () => {
    for (const [tooBig, cause, colour] of [
      [false, "change", "red"],
      [true, "other", "red"],
      [false, "copy", "blue"],
      [false, "other", "blue"],
    ] as const) {
      const { unmount } = setup(undefined, tooBig, { cause });
      const style = alertBox().getAttribute("style") ?? "";
      expect([cause, tooBig, style]).toEqual([
        cause,
        tooBig,
        expect.stringContaining(`--mantine-color-${colour}-light`),
      ]);
      expect(style).not.toContain("yellow");
      unmount();
    }
  });
});

describe("CollabRefusalNotice in Read mode or without edit permission (passive)", () => {
  it("is a status that does not take focus, with the same text", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    setup(undefined, false, { cause: "copy", passive: true });
    expect(screen.queryByRole("alert")).toBeNull();
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("stored copy");
    expect(document.activeElement).toBe(outside);
    expect(document.activeElement).not.toBe(status);
    outside.remove();
  });

  it("switching to Edit makes it an alert and moves focus to it", () => {
    const { rerender } = setup(undefined, false, { cause: "copy", passive: true });
    expect(document.activeElement).not.toBe(screen.getByRole("status"));
    rerender({ cause: "copy", passive: false });
    const alert = screen.getByRole("alert");
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.activeElement).toBe(alert);
  });

  it("switching back to Read never moves focus away from where the user put it", () => {
    const { rerender } = setup(undefined, false, { cause: "copy", passive: false });
    expect(document.activeElement).toBe(screen.getByRole("alert"));
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    rerender({ cause: "copy", passive: true });
    expect(screen.getByRole("status")).toBeTruthy();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});

describe("the Discard confirm and the view on screen (showsLocalCopy)", () => {
  it("with this browser's copy on screen, it asks the user to copy what they need first", async () => {
    setup(undefined, false, { showsLocalCopy: true });
    fireEvent.click(discardButton());
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Any changes in this browser");
    expect(dialog.textContent).toContain("copy anything you need");
    expect(dialog.textContent).not.toContain("last version the server saved");
  });

  it("with the server's saved version on screen, it says unsent changes are not shown and cannot be recovered", async () => {
    setup(undefined, false, { showsLocalCopy: false });
    fireEvent.click(discardButton());
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Any changes in this browser");
    expect(dialog.textContent).toContain("last version the server saved");
    expect(dialog.textContent).toContain("cannot be recovered");
    expect(dialog.textContent).not.toContain("copy anything you need");
    expect(dialog.textContent).toContain("Close any other tabs of this page");
  });
});

// i18next reads ":" in a key as a namespace separator, so a translated string with a colon would render wrongly.
it("no notice string contains a colon", () => {
  const source = readFileSync(join(__dirname, "collab-refusal-notice.tsx"), "utf8");
  const keys = [...source.matchAll(/\bt\(\s*"([^"]+)"/g)].map((m) => m[1]);
  expect(keys.length).toBeGreaterThanOrEqual(15);
  expect(keys.filter((k) => k.includes(":"))).toEqual([]);
});
