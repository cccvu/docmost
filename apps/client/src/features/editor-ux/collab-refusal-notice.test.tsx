import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

// cccvu/wiki-v2#781 — the notice an editor shows once the server refused one of its collab frames.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import {
  CollabPageNotices,
  CollabRefusalNotice,
} from "./collab-refusal-notice";
import { initialCollabAccess } from "./collab-access";
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

function setup(
  clearLocalCopy: () => Promise<void> = async () => {},
  kind?: CollabRefusalKind,
) {
  const calls: string[] = [];
  const clear = vi.fn(async () => {
    calls.push("clear");
    await clearLocalCopy();
  });
  const reload = vi.fn(() => calls.push("reload"));
  render(
    <MantineProvider>
      <CollabRefusalNotice
        clearLocalCopy={clear}
        reload={reload}
        kind={kind}
      />
    </MantineProvider>,
  );
  return { calls, clear, reload };
}

const discardButton = () =>
  screen.getByRole("button", { name: "Discard this browser's copy" });

describe("CollabRefusalNotice", () => {
  it("is an alert that takes focus, so keyboard and screen-reader users reach it", () => {
    setup();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveProperty(
      "textContent",
      expect.stringContaining("Your latest changes were not saved"),
    );
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
  ) {
    const openCurrentVersion = vi.fn();
    const clearLocalCopy = vi.fn(async () => {});
    render(
      <MantineProvider>
        <CollabPageNotices
          access={{ ...initialCollabAccess, ...access }}
          epoch={{ compactedTo, openCurrentVersion }}
          clearLocalCopy={clearLocalCopy}
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
