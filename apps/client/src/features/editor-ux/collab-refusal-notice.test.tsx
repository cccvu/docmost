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

import { CollabRefusalNotice } from "./collab-refusal-notice";

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
  tooBig?: boolean,
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
        tooBig={tooBig}
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
describe("CollabRefusalNotice after a 1009 (tooBig)", () => {
  it("says the change is too large, offers no Reload, and makes Discard the primary (filled) button", () => {
    setup(undefined, true);
    expect(screen.getByRole("alert").textContent).toContain(
      "too large to send",
    );
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
    const discard = discardButton();
    expect(discard.getAttribute("data-variant")).toBe("filled");
  });

  it("Discard still asks first, then clears this browser's copy and reloads", async () => {
    const { calls } = setup(undefined, true);
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
    }, true);
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
  it("without tooBig, Reload is offered and Discard is not the primary button", () => {
    setup();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(discardButton().getAttribute("data-variant")).toBe("default");
    expect(screen.getByRole("alert").textContent).not.toContain(
      "too large to send",
    );
  });
});
