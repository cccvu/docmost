import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

// #818 post-sign-in reminder (after a passkey sign-in with ≤ 30 days of email proof left): a focused full-page
// screen whose only fix is an emailed code, so ConfirmItsYouDialog opens with the EMAIL method only.

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) =>
      k.replace(/{{(\w+)}}/g, (_: string, n: string) => String(o?.[n])),
  }),
}));
vi.mock("./confirm-its-you-dialog.tsx", () => ({
  ConfirmItsYouDialog: (p: {
    opened: boolean;
    methods: readonly string[];
    onConfirmed: () => void;
    onClose: () => void;
  }) =>
    p.opened ? (
      <div data-testid="confirm" data-methods={p.methods.join(",")}>
        <button onClick={p.onConfirmed}>confirm-stub</button>
        <button onClick={p.onClose}>close-stub</button>
      </div>
    ) : null,
}));

import { PasskeyReminder } from "./passkey-reminder.tsx";

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});
afterEach(() => cleanup());

function renderReminder(daysLeft = 12) {
  const onDone = vi.fn();
  render(
    <MantineProvider>
      <PasskeyReminder daysLeft={daysLeft} onDone={onDone} />
    </MantineProvider>,
  );
  return onDone;
}

describe("PasskeyReminder", () => {
  it("focuses its heading and names the days left", () => {
    renderReminder(12);
    const heading = screen.getByRole("heading", {
      name: /confirm your email to keep your passkey working/i,
    });
    expect(document.activeElement).toBe(heading);
    expect(screen.getByText(/stops working in 12 days/i)).toBeTruthy();
  });

  it("one day left says 'tomorrow'", () => {
    renderReminder(1);
    expect(screen.getByText(/stops working tomorrow/i)).toBeTruthy();
  });

  it("'Not now' leaves", () => {
    const onDone = renderReminder();
    fireEvent.click(screen.getByRole("button", { name: /^not now$/i }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("'Confirm my email' opens the dialog with the EMAIL method only; success announces and offers Continue", async () => {
    const onDone = renderReminder();
    fireEvent.click(screen.getByRole("button", { name: /confirm my email/i }));
    const dialog = screen.getByTestId("confirm");
    expect(dialog.getAttribute("data-methods")).toBe("email");
    fireEvent.click(screen.getByRole("button", { name: "confirm-stub" }));
    expect(screen.queryByTestId("confirm")).toBeNull();
    const status = document.querySelector(
      '[role="status"][aria-live="polite"]',
    ) as HTMLElement;
    expect(status.textContent).toMatch(/your email is confirmed/i);
    const cont = screen.getByRole("button", { name: /^continue$/i });
    await waitFor(() => expect(document.activeElement).toBe(cont));
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(cont);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("closing the dialog keeps the reminder (nothing confirmed)", () => {
    const onDone = renderReminder();
    fireEvent.click(screen.getByRole("button", { name: /confirm my email/i }));
    fireEvent.click(screen.getByRole("button", { name: "close-stub" }));
    expect(screen.queryByTestId("confirm")).toBeNull();
    expect(
      screen.getByRole("button", { name: /confirm my email/i }),
    ).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
  });
});
