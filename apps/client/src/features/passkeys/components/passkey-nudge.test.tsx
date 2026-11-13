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
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

// #818 post-sign-in nudge: a focused full-page screen with "Create a passkey" / "Not now" / "Don't ask again on this
// device". "Create" starts the ceremony synchronously inside its click; a request to confirm opens ConfirmItsYouDialog
// with the methods the error table names, and a NEW "Continue" click retries (Safari's gesture rule).

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) =>
      k.replace(/{{(\w+)}}/g, (_: string, n: string) => String(o?.[n])),
  }),
}));

const m = vi.hoisted(() => ({
  register: vi.fn(async (): Promise<unknown> => ({ id: "p1" })),
  dismiss: vi.fn(),
}));
vi.mock("../services/passkey-api.ts", () => ({
  registerPasskey: () => m.register(),
}));
vi.mock("../lib/nudge-storage.ts", () => ({
  dismissPasskeyNudge: () => m.dismiss(),
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

import { PasskeyNudge } from "./passkey-nudge.tsx";
import { PasskeyError, httpFailure } from "../lib/passkey-errors.ts";

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

beforeEach(() => {
  m.register.mockImplementation(async () => ({ id: "p1" }));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderNudge() {
  const onDone = vi.fn();
  render(
    <MantineProvider>
      <PasskeyNudge onDone={onDone} />
    </MantineProvider>,
  );
  return onDone;
}

const refused = (status: number, body: Record<string, unknown>) =>
  new PasskeyError(httpFailure("request", status, body, null));
const status = () =>
  document.querySelector('[role="status"][aria-live="polite"]') as HTMLElement;

describe("PasskeyNudge", () => {
  it("focuses its heading and offers the three choices, with the 'device that's yours' caution", () => {
    renderNudge();
    const heading = screen.getByRole("heading", {
      name: /sign in faster with a passkey/i,
    });
    expect(document.activeElement).toBe(heading);
    expect(
      screen.getByText(/only create a passkey on a device that's yours/i),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /create a passkey/i }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /^not now$/i })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /don't ask again on this device/i }),
    ).toBeTruthy();
  });

  it("'Not now' leaves without remembering anything", () => {
    const onDone = renderNudge();
    fireEvent.click(screen.getByRole("button", { name: /^not now$/i }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(m.dismiss).not.toHaveBeenCalled();
    expect(m.register).not.toHaveBeenCalled();
  });

  it("'Don't ask again on this device' remembers it, then leaves", () => {
    const onDone = renderNudge();
    fireEvent.click(
      screen.getByRole("button", { name: /don't ask again on this device/i }),
    );
    expect(m.dismiss).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("'Create a passkey' starts the ceremony inside the click, then announces success and offers Continue", async () => {
    const onDone = renderNudge();
    fireEvent.click(screen.getByRole("button", { name: /create a passkey/i }));
    expect(m.register).toHaveBeenCalledTimes(1); // synchronously, within the click
    const cont = await screen.findByRole("button", { name: /^continue$/i });
    expect(status().textContent).toMatch(/passkey created/i);
    await waitFor(() => expect(document.activeElement).toBe(cont));
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(cont);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("a cancelled prompt changes nothing", async () => {
    m.register.mockRejectedValueOnce(new PasskeyError({ kind: "cancelled" }));
    const onDone = renderNudge();
    fireEvent.click(screen.getByRole("button", { name: /create a passkey/i }));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: /create a passkey/i,
          }) as HTMLButtonElement
        ).hasAttribute("data-loading"),
      ).toBe(false),
    );
    expect(status().textContent).toBe("");
    expect(onDone).not.toHaveBeenCalled();
  });

  it("this device already has one → says so, stays on the screen", async () => {
    m.register.mockRejectedValueOnce(
      new PasskeyError({ kind: "already-registered" }),
    );
    renderNudge();
    fireEvent.click(screen.getByRole("button", { name: /create a passkey/i }));
    await waitFor(() =>
      expect(status().textContent).toBe(
        "This device already has a passkey for your account.",
      ),
    );
  });

  it("the per-user add budget is spent → says when, stays on the screen (#818)", async () => {
    m.register.mockRejectedValueOnce(
      new PasskeyError(
        httpFailure(
          "options",
          429,
          { code: "rate_limited", limit: "passkey_add", message: "x" },
          "86400",
        ),
      ),
    );
    const onDone = renderNudge();
    fireEvent.click(screen.getByRole("button", { name: /create a passkey/i }));
    await waitFor(() =>
      expect(status().textContent).toBe(
        "You've added several passkeys recently. Try again in about 24 hours.",
      ),
    );
    expect(onDone).not.toHaveBeenCalled();
  });

  it("an older platform (404 on options) has nothing to offer: leave", async () => {
    m.register.mockRejectedValueOnce(
      new PasskeyError(httpFailure("options", 404, {}, null)),
    );
    const onDone = renderNudge();
    fireEvent.click(screen.getByRole("button", { name: /create a passkey/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it.each([
    ["step_up_required", 403],
    ["email_confirmation_required", 403],
  ])(
    "%s → ConfirmItsYouDialog with the EMAIL method only; then a NEW Continue click retries",
    async (code, httpStatus) => {
      m.register.mockRejectedValueOnce(refused(httpStatus, { code }));
      renderNudge();
      fireEvent.click(
        screen.getByRole("button", { name: /create a passkey/i }),
      );
      const dialog = await screen.findByTestId("confirm");
      expect(dialog.getAttribute("data-methods")).toBe("email");
      fireEvent.click(screen.getByRole("button", { name: "confirm-stub" }));
      expect(screen.queryByTestId("confirm")).toBeNull();
      // Nothing retried by itself after the dialog: the ceremony needs a fresh click.
      expect(m.register).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));
      expect(m.register).toHaveBeenCalledTimes(2);
      await waitFor(() =>
        expect(status().textContent).toMatch(/passkey created/i),
      );
    },
  );

  it("closing the dialog returns to the offer", async () => {
    m.register.mockRejectedValueOnce(
      refused(403, { code: "step_up_required" }),
    );
    renderNudge();
    fireEvent.click(screen.getByRole("button", { name: /create a passkey/i }));
    await screen.findByTestId("confirm");
    fireEvent.click(screen.getByRole("button", { name: "close-stub" }));
    expect(screen.queryByTestId("confirm")).toBeNull();
    expect(
      screen.getByRole("button", { name: /create a passkey/i }),
    ).toBeTruthy();
  });
});
