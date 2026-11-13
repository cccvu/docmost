// #764: "Send feedback" in the avatar menu, rendered through the REAL TopMenu seam (upstream-owned
// top-menu.tsx) with its unrelated dependencies stubbed. Covers visibility, the payload, the per-draft
// idempotency key, focus on success, and every inline failure state.
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getDefaultStore } from "jotai";
import TopMenu from "@/components/layouts/global/top-menu";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom.ts";

const getMock = vi.fn();
const postMock = vi.fn();
vi.mock("@/lib/platform-client", () => ({
  default: {
    get: (...a: unknown[]) => getMock(...a),
    post: (...a: unknown[]) => postMock(...a),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, o?: Record<string, unknown>) =>
      key.replace(/\{\{(\w+)\}\}/g, (_, n) => String(o?.[n])),
  }),
}));

let native = false;
vi.mock("@/features/auth-native/lib/auth-mode", () => ({
  isNativeAuthEnabled: () => native,
}));

const PAGE_UUID = "0b6a6f8e-8d1c-4b8a-9c41-1f0c1a2b3c4d";
vi.mock("@/features/page/queries/page-query", () => ({
  usePageQuery: ({ pageId }: { pageId?: string }) => ({
    data:
      pageId === "AbC123xyz"
        ? { id: PAGE_UUID, title: "Secret plans", slugId: "AbC123xyz" }
        : undefined,
  }),
}));

// Unrelated TopMenu dependencies.
vi.mock("@/ee/hooks/use-feature", () => ({ useHasFeature: () => false }));
vi.mock("@/ee/features", () => ({ Feature: { PERSONAL_SPACES: "p" } }));
vi.mock("@/ee/personal-space/queries/personal-space-query", () => ({
  usePersonalSpaceQuery: () => ({ data: undefined }),
}));
vi.mock("@/ee/personal-space/components/create-personal-space-modal", () => ({
  default: () => null,
}));
vi.mock("@/features/auth/hooks/use-auth.ts", () => ({
  default: () => ({ logout: vi.fn() }),
}));
vi.mock("@/components/ui/custom-avatar.tsx", () => ({
  CustomAvatar: () => null,
}));
vi.mock("@/features/public/components/public-auth-buttons.tsx", () => ({
  PublicAuthButtons: () => null,
}));
vi.mock("@/lib/config.ts", () => ({ getSpaceUrl: (s: string) => `/s/${s}` }));
vi.mock("@/features/user/atoms/current-user-atom.ts", async () => {
  const { atom } = await import("jotai");
  return { currentUserAtom: atom<unknown>(null) };
});

// The stored users.role. useUserRole() (real) reads it only in native mode (#636).
function signInAs(role: "owner" | "admin" | "member") {
  getDefaultStore().set(currentUserAtom as never, {
    user: { name: "Ada", email: "ada@example.edu", avatarUrl: null, role },
    workspace: { name: "Wiki", logo: null, settings: {} },
  } as never);
}

const writeText = vi.fn();

beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
  if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  // Mantine's autosize Textarea listens on document.fonts, which jsdom lacks.
  if (!(document as { fonts?: unknown }).fonts) {
    Object.defineProperty(document, "fonts", {
      value: { addEventListener: () => {}, removeEventListener: () => {} },
      configurable: true,
    });
  }
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

beforeEach(() => {
  native = false;
  signInAs("member");
  getMock.mockReset();
  postMock.mockReset();
  writeText.mockReset().mockResolvedValue(undefined);
  getMock.mockResolvedValue({ data: { enabled: true } });
});

afterEach(cleanup);

function renderMenu(path = "/home") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MantineProvider env="test">
        <MemoryRouter initialEntries={[path]}>
          <TopMenu />
        </MemoryRouter>
      </MantineProvider>
    </QueryClientProvider>,
  );
}

function openAccountMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
}

const feedbackItem = () =>
  screen.queryByRole("menuitem", { name: "Send feedback" });

async function openFeedback(path?: string) {
  renderMenu(path);
  openAccountMenu();
  await waitFor(() => expect(getMock).toHaveBeenCalled());
  fireEvent.click(await screen.findByRole("menuitem", { name: "Send feedback" }));
  return screen.findByRole("dialog");
}

function fill(
  dialog: HTMLElement,
  v: { type?: string; title?: string; description?: string } = {},
) {
  fireEvent.click(within(dialog).getByLabelText(v.type ?? "Bug"));
  fireEvent.change(within(dialog).getByLabelText("Summary"), {
    target: { value: v.title ?? "Search is slow" },
  });
  fireEvent.change(within(dialog).getByLabelText("Details"), {
    target: { value: v.description ?? "Every search takes ten seconds." },
  });
}

const send = (dialog: HTMLElement, name = "Send feedback") =>
  fireEvent.click(within(dialog).getByRole("button", { name }));

function httpError(
  status: number,
  data: unknown,
  headers: Record<string, string> = {},
) {
  return { isAxiosError: true, response: { status, data, headers } };
}
const problem = (
  status: number,
  code: string,
  detail = "d",
  headers: Record<string, string> = {},
) =>
  httpError(
    status,
    { type: "about:blank", title: "T", status, code, detail },
    { "content-type": "application/problem+json", ...headers },
  );

const keyOf = (call: unknown[]) =>
  (call[2] as { headers: Record<string, string> }).headers["Idempotency-Key"];

describe("avatar menu entry", () => {
  it("labels the trigger and puts Send feedback in its own group above Logout", async () => {
    renderMenu();
    openAccountMenu();
    await waitFor(() => expect(getMock).toHaveBeenCalledWith("/v1/feedback/status"));
    const items = (await screen.findAllByRole("menuitem")).map(
      (i) => i.textContent,
    );
    const at = items.indexOf("Send feedback");
    expect(at).toBeGreaterThan(-1);
    expect(items[at + 1]).toBe("Logout");
  });

  it("does not probe the status before the menu is opened", () => {
    renderMenu();
    expect(getMock).not.toHaveBeenCalled();
  });

  it("is hidden when the platform says feedback is off", async () => {
    getMock.mockResolvedValue({ data: { enabled: false } });
    renderMenu();
    openAccountMenu();
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await waitFor(() => expect(feedbackItem()).toBeNull());
    expect(screen.getByRole("menuitem", { name: "Logout" })).toBeTruthy();
  });

  it("#797: no Manage members link in remote mode (the native screen is not served); native keeps it", async () => {
    renderMenu();
    openAccountMenu();
    await screen.findByRole("menuitem", { name: "Logout" });
    expect(screen.queryByRole("menuitem", { name: "Manage members" })).toBeNull();
    cleanup();
    native = true;
    signInAs("owner");
    renderMenu();
    openAccountMenu();
    expect(await screen.findByRole("menuitem", { name: "Manage members" })).toBeTruthy();
  });

  // wiki-v2 UI cleanup: the Workspace group (label, both items, divider) is admin-only, through
  // useUserRole() — which answers member for everyone in remote mode, whatever users.role says.
  const workspaceGroup = () => ({
    label: screen.queryByText("Workspace"),
    settings: screen.queryByRole("menuitem", { name: "Workspace settings" }),
    members: screen.queryByRole("menuitem", { name: "Manage members" }),
  });

  it.each(["owner", "admin", "member"] as const)(
    "remote %s: no Workspace group and no (synthetic) email line",
    async (role) => {
      signInAs(role);
      renderMenu();
      openAccountMenu();
      await screen.findByRole("menuitem", { name: "Logout" });
      expect(workspaceGroup()).toEqual({ label: null, settings: null, members: null });
      expect(screen.queryByText("ada@example.edu")).toBeNull();
      // The Account group is unchanged.
      expect(screen.getByText("Account")).toBeTruthy();
      expect(screen.getByRole("menuitem", { name: "My profile" })).toBeTruthy();
    },
  );

  it.each(["owner", "admin"] as const)(
    "native %s: the Workspace group and the email line are shown",
    async (role) => {
      native = true;
      signInAs(role);
      renderMenu();
      openAccountMenu();
      await screen.findByRole("menuitem", { name: "Logout" });
      const group = workspaceGroup();
      expect(group.label).toBeTruthy();
      expect(group.settings?.getAttribute("href")).toBe("/settings/workspace");
      expect(group.members?.getAttribute("href")).toBe("/settings/members");
      expect(screen.getByText("ada@example.edu")).toBeTruthy();
    },
  );

  it("native member: no Workspace group (no empty header); the email line is shown", async () => {
    native = true;
    signInAs("member");
    renderMenu();
    openAccountMenu();
    await screen.findByRole("menuitem", { name: "Logout" });
    expect(workspaceGroup()).toEqual({ label: null, settings: null, members: null });
    expect(screen.getByText("ada@example.edu")).toBeTruthy();
  });

  it("is hidden in native (standalone) mode and never calls the platform", async () => {
    native = true;
    renderMenu();
    openAccountMenu();
    await screen.findByRole("menuitem", { name: "Logout" });
    expect(feedbackItem()).toBeNull();
    expect(getMock).not.toHaveBeenCalled();
  });
});

describe("feedback dialog", () => {
  it("validates every field inline before sending anything", async () => {
    const dialog = await openFeedback();
    send(dialog);
    await waitFor(() =>
      expect(within(dialog).getAllByRole("alert")).toHaveLength(3),
    );
    expect(dialog.textContent).toContain("Choose what kind of feedback this is");
    expect(dialog.textContent).toContain("Summary must be at least 3 characters");
    expect(dialog.textContent).toContain("Details must be at least 10 characters");
    expect(postMock).not.toHaveBeenCalled();
  });

  it("off a page: no page checkbox, and the body is exactly type/title/description", async () => {
    postMock.mockResolvedValue({ data: { reference: "FB-0123456789", issueNumber: 7 } });
    const dialog = await openFeedback("/home");
    expect(within(dialog).queryByLabelText("Include a link to this page")).toBeNull();
    fill(dialog, { type: "Feature idea" });
    send(dialog);
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [url, body, config] = postMock.mock.calls[0];
    expect(url).toBe("/v1/feedback");
    expect(body).toEqual({
      type: "feature",
      title: "Search is slow",
      description: "Every search takes ten seconds.",
    });
    expect(Object.keys(body).sort()).toEqual(["description", "title", "type"]);
    expect(keyOf(postMock.mock.calls[0])).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(Object.keys((config as { headers: object }).headers)).toEqual([
      "Idempotency-Key",
    ]);
  });

  it("on a page: sends only the page id when opted in — never the path, slug or title", async () => {
    postMock.mockResolvedValue({ data: { reference: "FB-0123456789", issueNumber: 7 } });
    const dialog = await openFeedback("/s/team-space/p/secret-plans-AbC123xyz");
    fill(dialog);
    fireEvent.click(within(dialog).getByLabelText("Include a link to this page"));
    send(dialog);
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const body = postMock.mock.calls[0][1];
    expect(body).toEqual({
      type: "bug",
      title: "Search is slow",
      description: "Every search takes ten seconds.",
      pageId: PAGE_UUID,
    });
    const wire = JSON.stringify(postMock.mock.calls[0]);
    for (const leak of ["secret-plans", "Secret plans", "team-space", "AbC123xyz", "/s/"]) {
      expect(wire).not.toContain(leak);
    }
  });

  it("reuses the key on retry, moves focus to the success status, and uses a new key for the next draft", async () => {
    postMock
      // A gateway 504 that never came from the platform: a same-key retry may replay the send.
      .mockRejectedValueOnce(httpError(504, "<html>Gateway Timeout</html>", { "content-type": "text/html" }))
      .mockResolvedValueOnce({ data: { reference: "FB-ABCDEFGHJK", issueNumber: 9 } })
      .mockResolvedValueOnce({ data: { reference: "FB-ZZZZZZZZZZ", issueNumber: 10 } });
    const dialog = await openFeedback();
    fill(dialog);
    send(dialog);

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain(
      "We couldn't confirm it arrived. Trying again won't send it twice.",
    );
    await waitFor(() => expect(document.activeElement).toBe(alert));

    send(dialog, "Try again");
    const status = await within(dialog).findByRole("status");
    expect(status.textContent).toContain("Thanks — sent. Reference FB-ABCDEFGHJK");
    await waitFor(() => expect(document.activeElement).toBe(status));
    expect(keyOf(postMock.mock.calls[1])).toBe(keyOf(postMock.mock.calls[0]));
    expect(postMock.mock.calls[1][1]).toEqual(postMock.mock.calls[0][1]);

    // The draft is cleared only now, after the success; focus lands in the fresh form, not on <body>.
    fireEvent.click(within(dialog).getByRole("button", { name: "Send more feedback" }));
    expect((within(dialog).getByLabelText("Summary") as HTMLInputElement).value).toBe("");
    await waitFor(() =>
      expect(document.activeElement).toBe(within(dialog).getByLabelText("Bug")),
    );
    fill(dialog);
    send(dialog);
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(3));
    expect(keyOf(postMock.mock.calls[2])).not.toBe(keyOf(postMock.mock.calls[0]));
  });

  it("the platform's 504: says it may have arrived, shows the reference, and offers no retry", async () => {
    postMock.mockRejectedValueOnce(
      problem(
        504,
        "upstream_timeout",
        "GitHub did not confirm the feedback (reference FB-ABCDEFGHJK), and it may have been sent.",
      ),
    );
    const dialog = await openFeedback();
    fill(dialog);
    send(dialog);
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("Please don't send it again. Reference FB-ABCDEFGHJK");
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(within(dialog).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Send feedback" })).toBeNull();
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it("409 idempotency_key_in_use: asks to wait, then a same-key retry gets the result", async () => {
    postMock
      .mockRejectedValueOnce(problem(409, "idempotency_key_in_use"))
      .mockResolvedValueOnce({ data: { reference: "FB-0123456789", issueNumber: 3 } });
    const dialog = await openFeedback();
    fill(dialog);
    send(dialog);
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toBe(
      "It's still being sent. Wait a few seconds, then select Try again.",
    );
    send(dialog, "Try again");
    await within(dialog).findByRole("status");
    expect(keyOf(postMock.mock.calls[1])).toBe(keyOf(postMock.mock.calls[0]));
  });

  it("keeps the draft and the key when the dialog is closed and reopened", async () => {
    postMock.mockRejectedValueOnce(problem(503, "service_unavailable"));
    const dialog = await openFeedback();
    fill(dialog, { title: "Draft survives" });
    send(dialog);
    await within(dialog).findByRole("alert");
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    openAccountMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Send feedback" }));
    const again = await screen.findByRole("dialog");
    expect((within(again).getByLabelText("Summary") as HTMLInputElement).value).toBe(
      "Draft survives",
    );
    postMock.mockResolvedValueOnce({ data: { reference: "FB-0123456789", issueNumber: 1 } });
    send(again);
    await within(again).findByRole("status");
    expect(keyOf(postMock.mock.calls[1])).toBe(keyOf(postMock.mock.calls[0]));
  });

  it.each([
    ["Escape", (dialog: HTMLElement) => fireEvent.keyDown(dialog, { key: "Escape" })],
    [
      "the Close button",
      (dialog: HTMLElement) =>
        fireEvent.click(within(dialog).getAllByRole("button", { name: "Close" })[0]),
    ],
  ])("closing with %s returns focus to the account menu trigger", async (_, close) => {
    const dialog = await openFeedback();
    const trigger = screen.getByRole("button", { name: "Account menu" });
    close(dialog);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("401: offers sign-in in a NEW tab and keeps the draft", async () => {
    postMock.mockRejectedValueOnce(problem(401, "unauthenticated"));
    const dialog = await openFeedback();
    fill(dialog, { title: "Keep me" });
    send(dialog);
    const alert = await within(dialog).findByRole("alert");
    const link = within(alert).getByRole("link", { name: "Sign in again" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener");
    expect(link.getAttribute("href")).toMatch(/^\/login/);
    expect((within(dialog).getByLabelText("Summary") as HTMLInputElement).value).toBe(
      "Keep me",
    );
    expect(within(dialog).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("401 from the status probe: leads with Sign in again before any send", async () => {
    getMock.mockRejectedValue(httpError(401, { status: 401, code: "unauthenticated" }));
    const dialog = await openFeedback();
    const alert = within(dialog).getByRole("alert");
    expect(within(alert).getByRole("link", { name: "Sign in again" })).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
  });

  it("429: says how long to wait (from Retry-After) and shows the server's detail", async () => {
    postMock.mockRejectedValueOnce(
      problem(429, "rate_limited", "You reached the wiki-wide feedback limit.", {
        "retry-after": "1800",
      }),
    );
    const dialog = await openFeedback();
    fill(dialog);
    send(dialog);
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("Please try again in about 30 minutes.");
    expect(alert.textContent).toContain("You reached the wiki-wide feedback limit.");
  });

  it("feedback_unavailable: 'off right now' with a Copy text button", async () => {
    postMock.mockRejectedValueOnce(problem(503, "feedback_unavailable"));
    const dialog = await openFeedback();
    fill(dialog);
    send(dialog);
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("Feedback is off right now");
    fireEvent.click(within(alert).getByRole("button", { name: "Copy text" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "Search is slow\n\nEvery search takes ten seconds.",
      ),
    );
  });

  it("an HTML 403 from the WAF: tells the reporter to remove code snippets", async () => {
    postMock.mockRejectedValueOnce(
      httpError(403, "<html><body>Forbidden</body></html>", {
        "content-type": "text/html",
      }),
    );
    const dialog = await openFeedback();
    fill(dialog);
    send(dialog);
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toBe(
      "Something in your text was blocked; remove code snippets and try again.",
    );
  });

  it("an edited draft after a failure gets a fresh key (no 409 idempotency_key_reused)", async () => {
    postMock.mockRejectedValueOnce(problem(503, "service_unavailable"));
    const dialog = await openFeedback();
    fill(dialog);
    send(dialog);
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toBe("Your feedback wasn't sent. (HTTP 503)");
    fireEvent.change(within(dialog).getByLabelText("Summary"), {
      target: { value: "Search is very slow" },
    });
    postMock.mockResolvedValueOnce({ data: { reference: "FB-0123456789", issueNumber: 1 } });
    send(dialog, "Try again");
    await within(dialog).findByRole("status");
    expect(keyOf(postMock.mock.calls[1])).not.toBe(keyOf(postMock.mock.calls[0]));
  });
});
