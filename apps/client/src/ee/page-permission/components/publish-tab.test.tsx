// CCC (fork-owned test, wiki-v2 #858): the "Share to web" switch reflects what the server did. A refused
// publish rolls the optimistic toggle back; a `share_not_permitted` refusal (ADR 0032 amendment, #704: the
// caller may edit but not publish) also disables the switch and says why, inline, for the rest of this modal
// session. Every switch has an accessible name. No failure escapes as an unhandled rejection.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const postMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({
  default: { post: (...a: unknown[]) => postMock(...a) },
}));
const notifyMock = vi.hoisted(() => vi.fn());
vi.mock("@mantine/notifications", () => ({
  notifications: { show: (...a: unknown[]) => notifyMock(...a) },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock("@/ee/hooks/use-trial", () => ({
  default: () => ({ isTrial: false, trialDaysLeft: null }),
}));

import { PublishTab } from "./publish-tab";

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
});

const REFUSAL = "Your role does not allow publishing pages to the web";
const DIRECT_SHARE = {
  id: "share-1",
  key: "k1",
  level: 0,
  pageId: "page-1",
  includeSubPages: true,
  searchIndexing: false,
};

function httpError(status: number, data: Record<string, unknown>) {
  return Object.assign(new Error(`HTTP ${status}`), {
    status,
    response: { status, data },
  });
}

type Routes = {
  share?: Record<string, unknown> | null;
  create?: Error;
  update?: Error;
  remove?: Error;
};

function route({ share = null, create, update, remove }: Routes) {
  postMock.mockImplementation(async (url: string) => {
    if (url === "/shares/for-page") return share ? { data: share } : {};
    if (url === "/shares/create") {
      if (create) throw create;
      return { data: DIRECT_SHARE };
    }
    if (url === "/shares/update") {
      if (update) throw update;
      return { data: DIRECT_SHARE };
    }
    if (url === "/shares/delete") {
      if (remove) throw remove;
      return {};
    }
    throw new Error(`unexpected POST ${url}`);
  });
}

let client: QueryClient;

/** The page's share state has loaded (clicking earlier races the load, which then resets the switch). */
async function loaded() {
  await waitFor(() =>
    expect(client.getQueryState(["share-for-page", "page-1"])?.status).toBe(
      "success",
    ),
  );
}

function renderTab() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MantineProvider env="test">
        <MemoryRouter initialEntries={["/s/space/p/page-slug"]}>
          <Routes>
            <Route
              path="/s/:spaceSlug/p/:pageSlug"
              element={<PublishTab pageId="page-1" />}
            />
          </Routes>
        </MemoryRouter>
      </MantineProvider>
    </QueryClientProvider>,
  );
}

function shareSwitch() {
  return screen.getByRole("switch", {
    name: /^Share(d)? to web$/,
  }) as HTMLInputElement;
}

function calledUrls() {
  return postMock.mock.calls.map((c) => c[0]);
}

beforeEach(() => {
  postMock.mockReset();
  notifyMock.mockReset();
});

describe("PublishTab (#858)", () => {
  it("names all three switches", async () => {
    route({ share: DIRECT_SHARE });
    renderTab();
    await waitFor(() => expect(shareSwitch().checked).toBe(true));
    // The name matches the visible label (WCAG 2.5.3): "Shared to web" while public.
    expect(screen.getByRole("switch", { name: "Shared to web" })).toBe(shareSwitch());
    expect(screen.getByRole("switch", { name: "Include sub-pages" })).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: "Search engine indexing" }),
    ).toBeTruthy();
  });

  it("share_not_permitted: the switch rolls back, is disabled and says why, and focus moves to the reason", async () => {
    route({
      create: httpError(403, { code: "share_not_permitted", message: REFUSAL }),
    });
    renderTab();
    await loaded();
    expect(shareSwitch().checked).toBe(false);
    expect(screen.getByRole("switch", { name: "Share to web" })).toBe(shareSwitch());

    shareSwitch().focus();
    fireEvent.click(shareSwitch());

    await waitFor(() => expect(shareSwitch().disabled).toBe(true));
    expect(shareSwitch().checked).toBe(false);
    const note = screen.getByText(REFUSAL);
    const describedBy = shareSwitch().getAttribute("aria-describedby") ?? "";
    expect(describedBy.split(" ")).toContain(note.id);
    expect(note.id).not.toBe("");
    // The pressed switch is now disabled, so it cannot keep focus: the reason takes it (#913).
    await waitFor(() => expect(document.activeElement).toBe(note));
  });

  it("share_not_permitted after the user moved on: focus stays where they put it", async () => {
    let refuse!: () => void;
    route({});
    const base = postMock.getMockImplementation()!;
    postMock.mockImplementation((url: string, ...rest: unknown[]) =>
      url === "/shares/create"
        ? new Promise((_, reject) => {
            refuse = () =>
              reject(
                httpError(403, { code: "share_not_permitted", message: REFUSAL }),
              );
          })
        : base(url, ...rest),
    );
    renderTab();
    await loaded();
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    try {
      shareSwitch().focus();
      fireEvent.click(shareSwitch());
      await waitFor(() => expect(calledUrls()).toContain("/shares/create"));
      elsewhere.focus();
      refuse();

      await waitFor(() => expect(screen.getByText(REFUSAL)).toBeTruthy());
      expect(document.activeElement).toBe(elsewhere);
    } finally {
      elsewhere.remove();
    }
  });

  it("any other refusal rolls the switch back and leaves it usable, with no inline note", async () => {
    route({
      create: httpError(503, { code: "engine_busy", message: "Try again" }),
    });
    renderTab();
    await loaded();

    shareSwitch().focus();
    fireEvent.click(shareSwitch());

    await waitFor(() => expect(calledUrls()).toContain("/shares/create"));
    await waitFor(() => expect(notifyMock).toHaveBeenCalled());
    expect(shareSwitch().checked).toBe(false);
    expect(shareSwitch().disabled).toBe(false);
    expect(document.activeElement).toBe(shareSwitch());
    expect(screen.queryByText(REFUSAL)).toBeNull();
    expect(shareSwitch().hasAttribute("aria-describedby")).toBe(false);
  });

  it("a refused unpublish turns the switch back on", async () => {
    route({
      share: DIRECT_SHARE,
      remove: httpError(503, { message: "Try again" }),
    });
    renderTab();
    await waitFor(() => expect(shareSwitch().checked).toBe(true));

    fireEvent.click(shareSwitch());

    await waitFor(() => expect(calledUrls()).toContain("/shares/delete"));
    await waitFor(() => expect(notifyMock).toHaveBeenCalled());
    expect(shareSwitch().checked).toBe(true);
  });

  it("a share_not_permitted update keeps the sub-switches as they were, disables them and says why", async () => {
    route({
      share: DIRECT_SHARE,
      update: httpError(403, { code: "share_not_permitted", message: REFUSAL }),
    });
    renderTab();
    const indexing = (await screen.findByRole("switch", {
      name: "Search engine indexing",
    })) as HTMLInputElement;
    expect(indexing.checked).toBe(false);

    indexing.focus();
    fireEvent.click(indexing);

    await waitFor(() => expect(screen.getByText(REFUSAL)).toBeTruthy());
    const subPages = screen.getByRole("switch", {
      name: "Include sub-pages",
    }) as HTMLInputElement;
    expect(indexing.checked).toBe(false);
    expect(indexing.disabled).toBe(true);
    expect(subPages.disabled).toBe(true);
    // Unpublishing stays possible: it narrows access, which the publish rule never blocks.
    expect(shareSwitch().disabled).toBe(false);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByText(REFUSAL)),
    );
  });
});
