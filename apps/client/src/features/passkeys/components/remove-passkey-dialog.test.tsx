import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import dialogSource from "./remove-passkey-dialog.tsx?raw";
import sectionSource from "./passkeys-section.tsx?raw";
import listSource from "./passkey-list.tsx?raw";

// #818 Profile → "Remove passkey {name}". Pins: the last-passkey warning; "this also signs you out on your other
// devices"; ONE call (the DELETE) and no client-side revoke; step_up_required → ConfirmItsYouDialog offering a
// passkey OR an emailed code, then a NEW click (nothing retries by itself); sign_out_incomplete → "Try again" after
// Retry-After, which re-sends the same DELETE; 404 → the list is refreshed.

vi.mock("react-i18next", async () => {
  const { translate } = await import("./profile-test-support.tsx");
  return { useTranslation: () => ({ t: translate }) };
});

const api = vi.hoisted(() => ({ remove: vi.fn() }));
vi.mock("../services/passkey-api.ts", () => ({
  removePasskey: (id: string) => api.remove(id),
}));
vi.mock("./confirm-its-you-dialog.tsx", async () => {
  const { StubConfirmDialog } = await import("./profile-test-support.tsx");
  return { ConfirmItsYouDialog: StubConfirmDialog };
});

import { RemovePasskeyDialog } from "./remove-passkey-dialog.tsx";
import {
  ceremonyError,
  httpError,
  installMatchMedia,
  passkey,
} from "./profile-test-support.tsx";
import type { PasskeyView } from "../types.ts";
import { PasskeyError } from "../lib/passkey-errors.ts";

const RESULT = { ok: true, platformSessionsRevoked: 2, wikiSessionsRevoked: 3 };

beforeAll(installMatchMedia);
beforeEach(() => {
  api.remove.mockImplementation(async () => RESULT);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

function renderDialog(
  opts: { target?: PasskeyView; isLast?: boolean; name?: string } = {},
) {
  const onClose = vi.fn();
  const onRemoved = vi.fn();
  const onChanged = vi.fn();
  render(
    <MantineProvider>
      <RemovePasskeyDialog
        passkey={opts.target ?? passkey()}
        name={opts.name ?? "iCloud Keychain"}
        isLast={opts.isLast ?? false}
        onClose={onClose}
        onRemoved={onRemoved}
        onChanged={onChanged}
      />
    </MantineProvider>,
  );
  return { onClose, onRemoved, onChanged };
}

const confirmButton = () =>
  screen.getByRole("button", { name: "Remove passkey" });

describe("RemovePasskeyDialog: copy", () => {
  it("names the passkey and says it signs out the other devices", async () => {
    renderDialog();
    expect(
      await screen.findByText("Remove passkey iCloud Keychain?"),
    ).toBeTruthy();
    expect(
      screen.getByText("iCloud Keychain will stop working for your account."),
    ).toBeTruthy();
    expect(
      screen.getByText("This also signs you out on your other devices."),
    ).toBeTruthy();
    expect(screen.queryByText(/only passkey/)).toBeNull();
  });

  it("warns when it is the last passkey", async () => {
    renderDialog({ isLast: true });
    expect(await screen.findByText("Remove your only passkey?")).toBeTruthy();
    expect(screen.getByText(/sign in with an email code only/)).toBeTruthy();
    expect(
      screen.getByText("This also signs you out on your other devices."),
    ).toBeTruthy();
  });

  it("a row whose removal did not finish offers to finish it", async () => {
    renderDialog({ target: passkey({ removalPending: true }), isLast: true });
    expect(
      await screen.findByText("Finish removing passkey iCloud Keychain"),
    ).toBeTruthy();
    expect(screen.getByText(/no longer works/)).toBeTruthy();
    // The passkey already does not work: no "only passkey" warning for it.
    expect(screen.queryByText(/only passkey/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(api.remove).toHaveBeenCalledWith(passkey().id);
  });
});

describe("RemovePasskeyDialog: the DELETE", () => {
  it("one DELETE for this passkey's row id, then onRemoved with the counts", async () => {
    const { onRemoved } = renderDialog();
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove passkey" }),
    );
    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith(RESULT));
    expect(api.remove).toHaveBeenCalledTimes(1);
    expect(api.remove).toHaveBeenCalledWith(passkey().id);
  });

  it("step_up_required → confirm with a passkey or an email code; a NEW click retries", async () => {
    api.remove.mockRejectedValueOnce(httpError(403, "step_up_required"));
    const { onRemoved } = renderDialog();
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove passkey" }),
    );
    const dialog = await screen.findByTestId("confirm-dialog");
    expect(dialog.getAttribute("data-methods")).toBe("passkey,email");

    fireEvent.click(screen.getByText("stub-confirm"));
    expect((await screen.findByRole("status")).textContent).toBe(
      "You're confirmed. Select Remove passkey to finish.",
    );
    // Confirming re-sends nothing by itself.
    expect(api.remove).toHaveBeenCalledTimes(1);
    expect(onRemoved).not.toHaveBeenCalled();

    fireEvent.click(confirmButton());
    await waitFor(() => expect(onRemoved).toHaveBeenCalledTimes(1));
    expect(api.remove).toHaveBeenCalledTimes(2);
  });

  it("sign_out_incomplete → 'Removal not finished', Try again after Retry-After re-sends the same DELETE", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.remove.mockRejectedValueOnce(
      httpError(503, "sign_out_incomplete", { retryAfter: "3" }),
    );
    const { onRemoved, onChanged } = renderDialog();
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove passkey" }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Removal not finished. Try again.",
    );
    // The list behind the dialog now shows the row as "Removal not finished".
    expect(onChanged).toHaveBeenCalledTimes(1);
    const retry = screen.getByRole("button", { name: /^Try again \(3s\)$/ });
    expect(retry.hasAttribute("disabled")).toBe(true);
    fireEvent.click(retry);
    expect(api.remove).toHaveBeenCalledTimes(1);

    // The countdown ticks once a second (a deadline, re-read on each tick).
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
    }
    const ready = await screen.findByRole("button", { name: "Try again" });
    expect(ready.hasAttribute("disabled")).toBe(false);
    fireEvent.click(ready);
    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith(RESULT));
    expect(api.remove).toHaveBeenCalledTimes(2);
    expect(api.remove).toHaveBeenLastCalledWith(passkey().id);
  });

  it("a DELETE 404 (already gone) refreshes the list and closes", async () => {
    api.remove.mockRejectedValueOnce(httpError(404));
    const { onClose, onChanged, onRemoved } = renderDialog();
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove passkey" }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onRemoved).not.toHaveBeenCalled();
  });

  it.each([
    [
      httpError(429, "rate_limited"),
      "Too many attempts, try again in a moment.",
    ],
    [httpError(503), "Temporarily unavailable, try again."],
    [httpError(401), "Your session has ended. Sign in again."],
    [new Error("boom"), "Something went wrong. Try again."],
  ])("shows other failures as an alert (%#)", async (error, text) => {
    api.remove.mockRejectedValueOnce(error);
    const { onRemoved, onClose } = renderDialog();
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove passkey" }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(text);
    expect(onRemoved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a cancelled step shows nothing", async () => {
    api.remove.mockRejectedValueOnce(ceremonyError("AbortError"));
    renderDialog();
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove passkey" }),
    );
    await waitFor(() => expect(api.remove).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("RemovePasskeyDialog: a failure may come after the passkey stopped", () => {
  const networkError = () =>
    new PasskeyError({ kind: "network", stage: "request" });

  it.each([
    ["429", httpError(429, "rate_limited", { retryAfter: "5" })],
    ["a dropped connection", networkError()],
    ["504", httpError(504)],
    ["503 without a code", httpError(503)],
    ["sign_out_incomplete", httpError(503, "sign_out_incomplete")],
    ["an unknown throw", new Error("boom")],
  ])(
    "%s re-reads the list (the row may now be 'Removal not finished')",
    async (_name, error) => {
      api.remove.mockRejectedValueOnce(error);
      const { onChanged, onRemoved } = renderDialog();
      fireEvent.click(
        await screen.findByRole("button", { name: "Remove passkey" }),
      );
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      expect(onRemoved).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["a cancel", ceremonyError("AbortError")],
    ["step_up_required", httpError(403, "step_up_required")],
  ])("%s changed nothing on the server: no re-read", async (_name, error) => {
    api.remove.mockRejectedValueOnce(error);
    const { onChanged } = renderDialog();
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove passkey" }),
    );
    await waitFor(() => expect(api.remove).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("a 429 holds the action for its Retry-After, then a new click re-sends the DELETE", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.remove.mockRejectedValueOnce(
      httpError(429, "rate_limited", { retryAfter: "2" }),
    );
    const { onRemoved } = renderDialog();
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove passkey" }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Too many attempts, try again in a moment.",
    );
    const held = screen.getByRole("button", { name: /^Try again \(2s\)$/ });
    expect(held.hasAttribute("disabled")).toBe(true);
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
    }
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove passkey" }),
    );
    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith(RESULT));
    expect(api.remove).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["no Retry-After → the default 3 s", undefined, 3],
    ["a huge Retry-After is capped at 60 s", "3600", 60],
  ])("a 429 with %s", async (_name, retryAfter, seconds) => {
    api.remove.mockRejectedValueOnce(
      httpError(429, "rate_limited", { retryAfter }),
    );
    renderDialog();
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove passkey" }),
    );
    const held = await screen.findByRole("button", {
      name: `Try again (${seconds}s)`,
    });
    expect(held.hasAttribute("disabled")).toBe(true);
  });

  it("cannot be closed while the DELETE is in flight (no close button, Escape ignored); can again after", async () => {
    let settle: (v: unknown) => void = () => undefined;
    api.remove.mockImplementationOnce(
      () => new Promise((resolve) => (settle = resolve)),
    );
    const { onClose, onRemoved } = renderDialog();
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove passkey" }),
    );
    await waitFor(() => expect(api.remove).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Close" })).toBeNull(),
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => settle(RESULT));
    await waitFor(() => expect(onRemoved).toHaveBeenCalledTimes(1));
  });

  it("positive control: idle, the close button and Escape both close", async () => {
    const { onClose } = renderDialog();
    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("a DELETE that succeeds after the dialog unmounted still re-reads the list", async () => {
    let settle: (v: unknown) => void = () => undefined;
    api.remove.mockImplementationOnce(
      () => new Promise((resolve) => (settle = resolve)),
    );
    const { onChanged, onRemoved } = renderDialog();
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove passkey" }),
    );
    await waitFor(() => expect(api.remove).toHaveBeenCalledTimes(1));
    cleanup();
    await act(async () => settle(RESULT));
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onRemoved).not.toHaveBeenCalled();
  });

  it("a failure after the dialog unmounted still re-reads the list", async () => {
    let fail: (e: unknown) => void = () => undefined;
    api.remove.mockImplementationOnce(
      () => new Promise((_, reject) => (fail = reject)),
    );
    const { onChanged } = renderDialog();
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove passkey" }),
    );
    await waitFor(() => expect(api.remove).toHaveBeenCalledTimes(1));
    cleanup();
    await act(async () => fail(httpError(504)));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});

describe("no client-side revoke (#818: the platform signs the other devices out)", () => {
  it.each([
    ["remove-passkey-dialog.tsx", dialogSource],
    ["passkeys-section.tsx", sectionSource],
    ["passkey-list.tsx", listSource],
  ])("%s calls no session revoke of its own", (_file, source) => {
    expect(source).not.toMatch(/features\/session\//);
    expect(source).not.toMatch(/\/api\/sessions/);
    expect(source).not.toMatch(
      /logout-all|revoke-all|revokeAll|revokeSession/i,
    );
    expect(source).not.toMatch(/platform-client/);
  });
});
