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

// #818 Profile → "Add a passkey". Pins: the ceremony starts synchronously inside the click; step_up_required and
// email_confirmation_required open ConfirmItsYouDialog with the emailed code ONLY; after it the ceremony is NOT
// started by the dialog's callback (Safari's gesture rule) but by a NEW "Continue" click; the error table's copy.

vi.mock("react-i18next", async () => {
  const { translate } = await import("./profile-test-support.tsx");
  return { useTranslation: () => ({ t: translate }) };
});

const api = vi.hoisted(() => ({ register: vi.fn() }));
vi.mock("../services/passkey-api.ts", () => ({
  registerPasskey: () => api.register(),
}));
const supported = vi.hoisted(() => ({ value: true }));
vi.mock("../lib/capabilities.ts", () => ({
  passkeysSupported: () => supported.value,
}));
vi.mock("./confirm-its-you-dialog.tsx", async () => {
  const { StubConfirmDialog } = await import("./profile-test-support.tsx");
  return { ConfirmItsYouDialog: StubConfirmDialog };
});

import { AddPasskeyButton } from "./add-passkey-button.tsx";
import {
  ceremonyError,
  httpError,
  installMatchMedia,
  passkey,
} from "./profile-test-support.tsx";

beforeAll(installMatchMedia);
beforeEach(() => {
  supported.value = true;
  api.register.mockImplementation(async () => passkey());
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderButton() {
  const onAdded = vi.fn();
  const onUnsupported = vi.fn();
  render(
    <MantineProvider>
      <AddPasskeyButton onAdded={onAdded} onUnsupported={onUnsupported} />
    </MantineProvider>,
  );
  return { onAdded, onUnsupported };
}

const addButton = () => screen.getByRole("button", { name: "Add a passkey" });

describe("AddPasskeyButton", () => {
  it("starts the ceremony synchronously inside the click and reports the new passkey", async () => {
    const { onAdded } = renderButton();
    fireEvent.click(addButton());
    // No await between the click and the api's one options fetch + create().
    expect(api.register).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(passkey()));
  });

  it("step_up_required → email-only confirm, then a NEW Continue click runs the ceremony", async () => {
    api.register.mockRejectedValueOnce(httpError(403, "step_up_required"));
    const { onAdded } = renderButton();
    fireEvent.click(addButton());
    const dialog = await screen.findByTestId("confirm-dialog");
    expect(dialog.getAttribute("data-methods")).toBe("email");

    fireEvent.click(screen.getByText("stub-confirm"));
    await waitFor(() =>
      expect(screen.queryByTestId("confirm-dialog")).toBeNull(),
    );
    // Confirming does not start a ceremony by itself.
    expect(api.register).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toMatch(/Select Continue/);

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(api.register).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(addButton()).toBeTruthy();
  });

  it("email_confirmation_required → email-only confirm too", async () => {
    api.register.mockRejectedValueOnce(
      httpError(403, "email_confirmation_required", { stage: "options" }),
    );
    renderButton();
    fireEvent.click(addButton());
    const dialog = await screen.findByTestId("confirm-dialog");
    expect(dialog.getAttribute("data-methods")).toBe("email");
  });

  it("dismissing the confirm leaves the plain Add button", async () => {
    api.register.mockRejectedValueOnce(httpError(403, "step_up_required"));
    renderButton();
    fireEvent.click(addButton());
    fireEvent.click(await screen.findByText("stub-dismiss"));
    await waitFor(() =>
      expect(screen.queryByTestId("confirm-dialog")).toBeNull(),
    );
    expect(addButton()).toBeTruthy();
    expect(api.register).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      httpError(409, "passkey_limit_reached"),
      "You already have 10 passkeys. Remove one first.",
    ],
    [
      httpError(409, "passkey_already_registered"),
      "This device already has a passkey for your account.",
    ],
    [
      ceremonyError("InvalidStateError"),
      "This device already has a passkey for your account.",
    ],
    [
      httpError(400, "passkey_challenge_stale"),
      "That took too long. Try again.",
    ],
    [
      httpError(400, "passkey_rejected"),
      "That passkey didn't work for your account.",
    ],
    [
      httpError(429, "rate_limited"),
      "Too many attempts, try again in a moment.",
    ],
    [httpError(503), "Temporarily unavailable, try again."],
  ])("shows the table's message (%#)", async (error, text) => {
    api.register.mockRejectedValueOnce(error);
    const { onAdded } = renderButton();
    fireEvent.click(addButton());
    expect((await screen.findByRole("alert")).textContent).toBe(text);
    expect(onAdded).not.toHaveBeenCalled();
    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
  });

  it("a cancelled prompt shows nothing and leaves the button enabled", async () => {
    api.register.mockRejectedValueOnce(ceremonyError("NotAllowedError"));
    renderButton();
    fireEvent.click(addButton());
    await waitFor(() =>
      expect(addButton().hasAttribute("data-loading")).toBe(false),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(addButton().hasAttribute("disabled")).toBe(false);
  });

  it("an older platform (404 on the options route) hides the section", async () => {
    api.register.mockRejectedValueOnce(
      httpError(404, undefined, { stage: "options" }),
    );
    const { onUnsupported } = renderButton();
    fireEvent.click(addButton());
    await waitFor(() => expect(onUnsupported).toHaveBeenCalledTimes(1));
  });

  it("a browser without WebAuthn gets no button", () => {
    supported.value = false;
    renderButton();
    expect(screen.queryByRole("button")).toBeNull();
    expect(
      screen.getByText("This browser can't create passkeys."),
    ).toBeTruthy();
  });
});
