import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Capture notifications.show calls without pulling in the real Mantine store.
const show = vi.fn();
vi.mock("@mantine/notifications", () => ({
  notifications: { show: (...args: unknown[]) => show(...args) },
}));

import { runDrawioSave } from "./drawio-save";

// Minimal translate stub (identity) typed loosely for the helper signature.
const t = ((key: string) => key) as unknown as Parameters<
  typeof runDrawioSave
>[2];

describe("runDrawioSave", () => {
  beforeEach(() => {
    show.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("closes the modal and shows no toast on a successful save", async () => {
    const close = vi.fn();
    await runDrawioSave(Promise.resolve(), close, t);
    expect(close).toHaveBeenCalledTimes(1);
    expect(show).not.toHaveBeenCalled();
  });

  it("keeps the modal open and shows one stable-id red toast on save failure", async () => {
    const close = vi.fn();
    await runDrawioSave(Promise.reject(new Error("boom")), close, t);
    // The diagram must NOT be discarded: the modal stays open.
    expect(close).not.toHaveBeenCalled();
    // Exactly one toast, with the stable id so retries replace rather than stack.
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({ id: "drawio-save-error", color: "red" }),
    );
  });
});
