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
  within,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

// #818 Profile → Passkeys. Pins: the captioned table (provider label or "Passkey", Synced / This device only, added,
// last used), the "works until" line, the half-finished removal row, the last-passkey warning, the browser told
// which credentials still work ONLY from a list the platform just answered, and the section hiding itself on an
// older platform or in native mode.

vi.mock("react-i18next", async () => {
  const { translate } = await import("./profile-test-support.tsx");
  return { useTranslation: () => ({ t: translate }) };
});

// date-locale reads only `language` from the app's i18n instance; the real one would init an http backend.
vi.mock("@/i18n.ts", () => ({ default: { language: "en-US" } }));

const api = vi.hoisted(() => ({
  list: vi.fn(),
  signal: vi.fn(),
  register: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("../services/passkey-api.ts", () => ({
  listPasskeys: () => api.list(),
  signalAcceptedPasskeys: (l: unknown) => api.signal(l),
  registerPasskey: () => api.register(),
  removePasskey: (id: string) => api.remove(id),
}));
vi.mock("../lib/capabilities.ts", () => ({ passkeysSupported: () => true }));
vi.mock("./confirm-its-you-dialog.tsx", async () => {
  const { StubConfirmDialog } = await import("./profile-test-support.tsx");
  return { ConfirmItsYouDialog: StubConfirmDialog };
});
const native = vi.hoisted(() => ({ value: false }));
vi.mock("@/features/auth-native/lib/auth-mode.ts", () => ({
  isNativeAuthEnabled: () => native.value,
}));

import PasskeysSection from "./passkeys-section.tsx";
import {
  httpError,
  installMatchMedia,
  listResponse,
  passkey,
} from "./profile-test-support.tsx";

const ICLOUD = passkey({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  credentialId: "aWNsb3Vk",
  aaguid: "FBFC3007-154E-4ECC-8C0B-6E020557D7BD",
  backupEligible: true,
  createdAt: "2026-11-02T12:00:00.000Z",
  lastUsedAt: "2026-11-10T12:00:00.000Z",
});
const KEY = passkey({
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  credentialId: "a2V5",
  aaguid: "00000000-0000-0000-0000-000000000000",
  backupEligible: false,
  createdAt: "2026-10-20T12:00:00.000Z",
  lastUsedAt: null,
});

beforeAll(installMatchMedia);
beforeEach(() => {
  native.value = false;
  api.list.mockImplementation(async () => listResponse([ICLOUD, KEY]));
  api.remove.mockImplementation(async () => ({
    ok: true,
    platformSessionsRevoked: 1,
    wikiSessionsRevoked: 1,
  }));
  api.register.mockImplementation(async () => KEY);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderSection() {
  return render(
    <MantineProvider>
      <PasskeysSection />
    </MantineProvider>,
  );
}

/** No heading, no divider, no text: the section is gone (MantineProvider's own style tags aside). */
function expectNothingRendered() {
  expect(screen.queryByRole("heading", { name: "Passkeys" })).toBeNull();
  expect(screen.queryAllByRole("separator")).toHaveLength(0);
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
}

async function table() {
  return screen.findByRole("table", { name: "Your passkeys" });
}

describe("PasskeysSection: the list", () => {
  it("shows a heading, the explainer and a captioned table", async () => {
    renderSection();
    expect(screen.getByRole("heading", { name: "Passkeys" })).toBeTruthy();
    expect(screen.getByText(/instead of a code from your email/)).toBeTruthy();
    const rows = within(await table()).getAllByRole("row");
    expect(rows).toHaveLength(3);
    const icloud = within(rows[1]);
    expect(icloud.getByText("iCloud Keychain")).toBeTruthy();
    expect(icloud.getByText("Synced")).toBeTruthy();
    expect(icloud.getByText("Nov 2, 2026")).toBeTruthy();
    expect(icloud.getByText("Nov 10, 2026")).toBeTruthy();
    const key = within(rows[2]);
    expect(key.getByText("Passkey")).toBeTruthy();
    expect(key.getByText("This device only")).toBeTruthy();
    expect(key.getByText("Never")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Remove passkey iCloud Keychain" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Remove passkey Passkey" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a passkey" })).toBeTruthy();
  });

  it("says when the passkeys work until", async () => {
    renderSection();
    expect(
      await screen.findByText(/Your passkeys work until Feb 10, 2027\./),
    ).toBeTruthy();
  });

  it.each([null, "2026-01-01T00:00:00.000Z"])(
    "says the passkeys are paused when the email proof is missing or lapsed (%s)",
    async (until) => {
      api.list.mockImplementation(async () =>
        listResponse([ICLOUD], { passkeysWorkUntil: until }),
      );
      renderSection();
      expect(await screen.findByText(/Your passkeys are paused/)).toBeTruthy();
      expect(screen.queryByText(/work until/)).toBeNull();
    },
  );

  it("an empty list says so, offers Add, and shows no works-until line", async () => {
    api.list.mockImplementation(async () => listResponse([]));
    renderSection();
    expect(
      await screen.findByText("You haven't added a passkey yet."),
    ).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(/work until|paused/)).toBeNull();
    expect(screen.getByRole("button", { name: "Add a passkey" })).toBeTruthy();
  });

  it("a row whose removal did not finish says so and offers Try again", async () => {
    api.list.mockImplementation(async () =>
      listResponse([passkey({ ...KEY, removalPending: true }), ICLOUD]),
    );
    renderSection();
    await table();
    expect(screen.getByText("Removal not finished")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Remove passkey Passkey" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Try again to remove passkey Passkey",
      }),
    );
    expect(
      await screen.findByText("Finish removing passkey Passkey"),
    ).toBeTruthy();
  });
});

describe("PasskeysSection: signalAllAcceptedCredentials", () => {
  it("is sent with the list the platform just answered", async () => {
    const answered = listResponse([ICLOUD, KEY]);
    api.list.mockImplementation(async () => answered);
    renderSection();
    await table();
    expect(api.signal).toHaveBeenCalledTimes(1);
    expect(api.signal.mock.calls[0][0]).toBe(answered);
  });

  it("is never sent after a failed list; a retry that succeeds sends it once", async () => {
    api.list.mockRejectedValueOnce(httpError(503));
    renderSection();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Temporarily unavailable/);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a passkey" })).toBeNull();
    expect(api.signal).not.toHaveBeenCalled();

    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await table();
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(api.signal).toHaveBeenCalledTimes(1);
  });
});

describe("PasskeysSection: a late answer", () => {
  it("an older list that answers after a newer one is neither shown nor signalled", async () => {
    const first = listResponse([ICLOUD, KEY]);
    const stale = listResponse([ICLOUD, KEY, passkey({ id: "c" })]);
    const fresh = listResponse([KEY]);
    let releaseStale: (v: unknown) => void = () => {};
    api.list
      .mockImplementationOnce(async () => first)
      .mockImplementationOnce(
        () => new Promise((resolve) => (releaseStale = resolve)),
      )
      .mockImplementationOnce(async () => fresh);
    renderSection();
    await table();
    // Two reloads in a row (two adds): the first is slow, the second answers at once.
    fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));
    await screen.findByText("Passkey added.");
    fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));
    await waitFor(() => expect(api.signal).toHaveBeenCalledTimes(2));
    expect(api.signal.mock.calls[1][0]).toBe(fresh);
    releaseStale(stale);
    await new Promise((r) => setTimeout(r, 0));
    expect(api.signal).toHaveBeenCalledTimes(2);
    expect(within(await table()).getAllByRole("row")).toHaveLength(2);
  });
});

describe("PasskeysSection: hidden", () => {
  it.each([404, 405])(
    "renders nothing on an older platform (%s)",
    async (status) => {
      api.list.mockRejectedValueOnce(httpError(status));
      renderSection();
      await waitFor(() => expectNothingRendered());
      expect(api.signal).not.toHaveBeenCalled();
    },
  );

  it("renders nothing and asks nothing in native mode", () => {
    native.value = true;
    renderSection();
    expectNothingRendered();
    expect(api.list).not.toHaveBeenCalled();
  });

  it("hides itself when Add finds no passkey routes", async () => {
    api.register.mockRejectedValueOnce(
      httpError(404, undefined, { stage: "options" }),
    );
    renderSection();
    await table();
    fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));
    await waitFor(() => expectNothingRendered());
  });
});

describe("PasskeysSection: add and remove", () => {
  it("Add reports success and reloads the list", async () => {
    renderSection();
    await table();
    fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));
    expect(await screen.findByText("Passkey added.")).toBeTruthy();
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  });

  it("Remove: confirm dialog, one DELETE by row id, success notice, list reloaded and re-signalled", async () => {
    const after = listResponse([KEY]);
    renderSection();
    await table();
    api.list.mockImplementation(async () => after);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove passkey iCloud Keychain" }),
    );
    expect(
      await screen.findByText("Remove passkey iCloud Keychain?"),
    ).toBeTruthy();
    // Not the only one: no last-passkey warning.
    expect(screen.queryByText(/only passkey/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove passkey" }));
    expect(await screen.findByText(/Passkey removed/)).toBeTruthy();
    expect(api.remove).toHaveBeenCalledTimes(1);
    expect(api.remove).toHaveBeenCalledWith(ICLOUD.id);
    await waitFor(() => expect(api.signal).toHaveBeenCalledTimes(2));
    expect(api.signal.mock.calls[1][0]).toBe(after);
  });

  it("warns on the last WORKING passkey (a half-removed one does not count)", async () => {
    api.list.mockImplementation(async () =>
      listResponse([ICLOUD, passkey({ ...KEY, removalPending: true })]),
    );
    renderSection();
    await table();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove passkey iCloud Keychain" }),
    );
    expect(await screen.findByText("Remove your only passkey?")).toBeTruthy();
  });

  it("Remove can be cancelled without any request", async () => {
    renderSection();
    await table();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove passkey Passkey" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByText("Remove passkey Passkey?")).toBeNull(),
    );
    expect(api.remove).not.toHaveBeenCalled();
  });
});

// #907: the dialog unmounts while still open, so Mantine's focus return never runs; the section restores it.
describe("PasskeysSection: focus after the remove dialog closes (#907)", () => {
  const heading = () => screen.getByRole("heading", { name: "Passkeys" });

  /** Focus a row's button and select it (fireEvent does not move focus the way a click or Enter does). */
  async function openFrom(name: string) {
    await table();
    const trigger = screen.getByRole("button", { name });
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole("dialog");
    return trigger;
  }

  async function expectFocused(el: HTMLElement) {
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(el));
    expect(document.activeElement).not.toBe(document.body);
  }

  it.each([
    [
      "Cancel",
      () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })),
    ],
    [
      "Escape",
      () => fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" }),
    ],
    [
      "the Close button",
      () => fireEvent.click(screen.getByRole("button", { name: "Close" })),
    ],
  ])("%s returns focus to the row's Remove button", async (_name, close) => {
    renderSection();
    const trigger = await openFrom("Remove passkey Passkey");
    close();
    await expectFocused(trigger);
    expect(api.remove).not.toHaveBeenCalled();
  });

  /** The next list answer waits for `release`: the row is still on the page when the dialog closes, as on a network. */
  function slowReload(next: ReturnType<typeof listResponse>) {
    let release: () => void = () => undefined;
    api.list.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve(next))),
    );
    return () => act(async () => release());
  }

  it("a removal focuses the heading at once, and keeps it once the row has left the list", async () => {
    renderSection();
    await openFrom("Remove passkey iCloud Keychain");
    const release = slowReload(listResponse([KEY]));
    fireEvent.click(screen.getByRole("button", { name: "Remove passkey" }));
    await screen.findByText(/Passkey removed/);
    await expectFocused(heading());
    // Not the row button that is about to go.
    expect(
      screen.getByRole("button", { name: "Remove passkey iCloud Keychain" }),
    ).toBeTruthy();
    await release();
    expect(
      screen.queryByRole("button", { name: "Remove passkey iCloud Keychain" }),
    ).toBeNull();
    expect(document.activeElement).toBe(heading());
  });

  it("a 404 (already gone) focuses the heading, not the row about to go", async () => {
    api.remove.mockRejectedValueOnce(httpError(404));
    renderSection();
    const trigger = await openFrom("Remove passkey Passkey");
    const release = slowReload(listResponse([ICLOUD]));
    fireEvent.click(screen.getByRole("button", { name: "Remove passkey" }));
    await expectFocused(heading());
    expect(trigger.isConnected).toBe(true);
    await release();
    expect(document.activeElement).toBe(heading());
  });

  it("after a half-finished removal, closing focuses the row's new Try again", async () => {
    api.remove.mockRejectedValueOnce(httpError(503, "sign_out_incomplete"));
    renderSection();
    const trigger = await openFrom("Remove passkey Passkey");
    api.list.mockImplementation(async () =>
      listResponse([ICLOUD, passkey({ ...KEY, removalPending: true })]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove passkey" }));
    await screen.findByText("Removal not finished. Try again.");
    // The reload replaced the row's Remove button with "Try again".
    await waitFor(() => expect(trigger.isConnected).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const retry = screen.getByRole("button", {
      name: "Try again to remove passkey Passkey",
    });
    await expectFocused(retry);
  });

  it("a Confirm-it's-you round trip, then Cancel, returns focus to the row's Remove button", async () => {
    api.remove.mockRejectedValueOnce(httpError(403, "step_up_required"));
    renderSection();
    const trigger = await openFrom("Remove passkey Passkey");
    fireEvent.click(screen.getByRole("button", { name: "Remove passkey" }));
    fireEvent.click(await screen.findByText("stub-confirm"));
    await screen.findByRole("status");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expectFocused(trigger);
  });
});
