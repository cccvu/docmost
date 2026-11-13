import { StrictMode } from "react";
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
import { AxiosError, AxiosHeaders } from "axios";
import dialogSource from "./confirm-its-you-dialog.tsx?raw";

// #818 ConfirmItsYouDialog. Pins the per-use methods (an email-only use never offers or probes a passkey, because
// only an emailed code records the mailbox proof that adding a passkey needs), that the passkey ceremony starts
// synchronously inside the click, and the email-code path's states.

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) =>
      k.replace(/{{(\w+)}}/g, (_: string, n: string) => String(o?.[n])),
  }),
}));

const api = vi.hoisted(() => ({
  probe: vi.fn(async () => true),
  reauth: vi.fn(async () => undefined),
  request: vi.fn(async () => ({ email: "a@b.test" })),
  verify: vi.fn(async (_otp: string) => undefined),
}));
vi.mock("../services/passkey-api.ts", () => ({
  probeReauthPasskey: () => api.probe(),
  reauthWithPasskey: () => api.reauth(),
  requestReauthCode: () => api.request(),
  verifyReauthCode: (otp: string) => api.verify(otp),
}));
const supported = vi.hoisted(() => ({ value: true }));
vi.mock("../lib/capabilities.ts", () => ({
  passkeysSupported: () => supported.value,
}));

import { ConfirmItsYouDialog } from "./confirm-its-you-dialog.tsx";
import { PasskeyError, httpFailure } from "../lib/passkey-errors.ts";
import type { ConfirmMethod } from "../types.ts";

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
  supported.value = true;
  api.probe.mockImplementation(async () => true);
  api.reauth.mockImplementation(async () => undefined);
  api.request.mockImplementation(async () => ({ email: "a@b.test" }));
  api.verify.mockImplementation(async () => undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function axiosError(status: number, data: unknown) {
  const err = new AxiosError("boom", "ERR_BAD_REQUEST");
  err.response = {
    status,
    statusText: "",
    data,
    headers: new AxiosHeaders(),
    config: { headers: new AxiosHeaders() },
  };
  return err;
}

function renderDialog(
  methods: ConfirmMethod[],
  opts: { strict?: boolean; onConfirmed?: () => void } = {},
) {
  const onConfirmed = opts.onConfirmed ?? vi.fn();
  const onClose = vi.fn();
  const tree = (
    <MantineProvider>
      <ConfirmItsYouDialog
        opened
        onClose={onClose}
        onConfirmed={onConfirmed}
        methods={methods}
      />
    </MantineProvider>
  );
  render(opts.strict ? <StrictMode>{tree}</StrictMode> : tree);
  return { onConfirmed, onClose };
}

const codeField = () => screen.getByLabelText(/Confirmation code/);

describe("email only (Add a passkey, the reminder)", () => {
  it("never probes or offers a passkey, mails a code at once, and confirms with it", async () => {
    const { onConfirmed } = renderDialog(["email"]);
    expect(await screen.findByText(/We sent a code to a@b.test/)).toBeTruthy();
    expect(api.probe).not.toHaveBeenCalled();
    expect(api.request).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /passkey/i })).toBeNull();

    fireEvent.change(codeField(), { target: { value: "1234 5678" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledTimes(1));
    expect(api.verify).toHaveBeenCalledWith("12345678");
    expect(api.reauth).not.toHaveBeenCalled();
  });

  it("mails once and probes nothing under StrictMode", async () => {
    renderDialog(["email"], { strict: true });
    await screen.findByText(/We sent a code to/);
    expect(api.request).toHaveBeenCalledTimes(1);
    expect(api.probe).not.toHaveBeenCalled();
  });

  it("a wrong code is announced and does not confirm", async () => {
    api.verify.mockRejectedValue(
      axiosError(400, { code: "reauth_code_invalid", message: "x" }),
    );
    const { onConfirmed } = renderDialog(["email"]);
    await screen.findByText(/We sent a code to/);
    fireEvent.change(codeField(), { target: { value: "12345678" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "That code is wrong or has expired. Request a new one.",
    );
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it("a malformed code is explained before any request", async () => {
    renderDialog(["email"]);
    await screen.findByText(/We sent a code to/);
    fireEvent.change(codeField(), { target: { value: "123456x" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /6 to 12 digits/,
    );
    expect(api.verify).not.toHaveBeenCalled();
  });

  it("a capped address says what works instead", async () => {
    api.request.mockRejectedValue(
      axiosError(400, { code: "reauth_capped", message: "x" }),
    );
    renderDialog(["email"]);
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Too many wrong codes/,
    );
  });

  it("a pasted whole code submits once", async () => {
    const { onConfirmed } = renderDialog(["email"]);
    await screen.findByText(/We sent a code to/);
    fireEvent.change(codeField(), {
      target: { value: "12345678" },
      nativeEvent: { inputType: "insertFromPaste" },
    });
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledTimes(1));
    expect(api.verify).toHaveBeenCalledTimes(1);
  });
});

describe("passkey or email (Remove passkey)", () => {
  it("offers the passkey first, without mailing a code", async () => {
    renderDialog(["passkey", "email"]);
    expect(
      await screen.findByRole("button", { name: "Use your passkey" }),
    ).toBeTruthy();
    expect(api.probe).toHaveBeenCalledTimes(1);
    expect(api.request).not.toHaveBeenCalled();
  });

  it("starts the ceremony synchronously inside the click, then confirms", async () => {
    const { onConfirmed } = renderDialog(["passkey", "email"]);
    const button = await screen.findByRole("button", {
      name: "Use your passkey",
    });
    fireEvent.click(button);
    // No waitFor: the call must already have happened within the click's task (Safari's gesture rule).
    expect(api.reauth).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledTimes(1));
    expect(api.request).not.toHaveBeenCalled();
  });

  it("'Email me a code instead' mails a code and can go back to the passkey", async () => {
    renderDialog(["passkey", "email"]);
    fireEvent.click(
      await screen.findByRole("button", { name: "Email me a code instead" }),
    );
    expect(await screen.findByText(/We sent a code to a@b.test/)).toBeTruthy();
    expect(api.request).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Use your passkey instead" }),
    );
    expect(api.reauth).toHaveBeenCalledTimes(1);
  });

  it("falls back to email when no passkey is available, or the browser has none", async () => {
    api.probe.mockImplementation(async () => false);
    renderDialog(["passkey", "email"]);
    expect(await screen.findByText(/We sent a code to/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Use your passkey/ }),
    ).toBeNull();
    cleanup();
    vi.clearAllMocks();

    supported.value = false;
    renderDialog(["passkey", "email"]);
    expect(await screen.findByText(/We sent a code to/)).toBeTruthy();
    expect(api.probe).not.toHaveBeenCalled();
  });

  it("a cancelled prompt changes nothing", async () => {
    api.reauth.mockRejectedValue(new PasskeyError({ kind: "cancelled" }));
    const { onConfirmed } = renderDialog(["passkey", "email"]);
    fireEvent.click(
      await screen.findByRole("button", { name: "Use your passkey" }),
    );
    await waitFor(() => expect(api.reauth).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Use your passkey" })
          .hasAttribute("data-loading"),
      ).toBe(false),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(api.request).not.toHaveBeenCalled();
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it("a rejected passkey switches to the emailed code with a note", async () => {
    api.reauth.mockRejectedValue(
      new PasskeyError(
        httpFailure("request", 400, { code: "passkey_rejected" }, null),
      ),
    );
    renderDialog(["passkey", "email"]);
    fireEvent.click(
      await screen.findByRole("button", { name: "Use your passkey" }),
    );
    expect(
      await screen.findByText("That passkey didn't work for your account."),
    ).toBeTruthy();
    await waitFor(() => expect(api.request).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByRole("button", { name: /Use your passkey/ }),
    ).toBeNull();
  });

  it("a stale challenge stays on the passkey with a retry message", async () => {
    api.reauth.mockRejectedValue(
      new PasskeyError(
        httpFailure("request", 400, { code: "passkey_challenge_stale" }, null),
      ),
    );
    renderDialog(["passkey", "email"]);
    fireEvent.click(
      await screen.findByRole("button", { name: "Use your passkey" }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "That took too long. Try again.",
    );
    expect(api.request).not.toHaveBeenCalled();
  });

  it("passkey-only with no passkey available mails nothing", async () => {
    api.probe.mockImplementation(async () => false);
    renderDialog(["passkey"]);
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /No passkey is available/,
    );
    expect(api.request).not.toHaveBeenCalled();
  });
});

describe("boundaries", () => {
  it("never goes through the console's confirm page", () => {
    expect(dialogSource).not.toMatch(
      /console\/confirm|stepUpConfirmHref|window\.location/,
    );
  });
});
