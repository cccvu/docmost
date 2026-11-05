import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Mode: remote unless a test flips it.
const nativeState = vi.hoisted(() => ({ value: false }));
vi.mock("@/features/auth-native/lib/auth-mode.ts", () => ({
  isNativeAuthEnabled: () => nativeState.value,
}));

// Every request goes through the app's api client; route the mock by URL. The client's response
// interceptor hands callers the server body, which wraps the payload in `data`.
const postMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({
  default: { post: (...a: unknown[]) => postMock(...a) },
}));

const notifyMock = vi.hoisted(() => vi.fn());
vi.mock("@mantine/notifications", () => ({
  notifications: { show: (...a: unknown[]) => notifyMock(...a) },
}));

// English literals with i18next-style interpolation (the app falls back to the key).
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, string>) =>
      k.replace(/{{(\w+)}}/g, (_, n: string) => o?.[n] ?? ""),
    i18n: { language: "en-US" },
  }),
}));

import { ShareExpiry, ShareExpiryProps } from "./share-expiry";

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
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
      ResizeObserverStub;
  }
  // Mantine's combobox scrolls the selected option into view.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

const EXPIRES = "2027-02-02T15:00:00.000Z";
const DIRECT_SHARE = { id: "share-1", key: "k1", level: 0, pageId: "page-1" };

type Routes = {
  share?: Record<string, unknown> | null;
  info?: { expiresAt: string | null } | { status: number };
  set?: { expiresAt: string | null } | { status: number };
};

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), {
    status,
    response: { status, data: { message: `HTTP ${status}` } },
  });
}

function route({ share = DIRECT_SHARE, info, set }: Routes) {
  postMock.mockImplementation(async (url: string) => {
    if (url === "/shares/for-page") return { data: share };
    if (url === "/shares/expiry/info") {
      if (info && "status" in info) throw httpError(info.status);
      return { data: info ?? { expiresAt: EXPIRES } };
    }
    if (url === "/shares/expiry") {
      if (set && "status" in set) throw httpError(set.status);
      return { data: set ?? { expiresAt: EXPIRES } };
    }
    throw new Error(`unexpected POST ${url}`);
  });
}

function renderExpiry(props: Partial<ShareExpiryProps> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const utils = render(
    <QueryClientProvider client={client}>
      <MantineProvider env="test">
        <ShareExpiry pageId="page-1" {...props} />
      </MantineProvider>
    </QueryClientProvider>,
  );
  return { client, ...utils };
}

// MantineProvider injects <style> tags, so "nothing" means none of this component's markup.
function expectNothingRendered(container: HTMLElement) {
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(container.querySelector("input, p, [data-testid]")).toBeNull();
  expect(screen.queryByText(/expire/i)).toBeNull();
}

function calledUrls() {
  return postMock.mock.calls.map((c) => c[0]);
}

function expectedDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

async function openSelect() {
  const input = await screen.findByRole("combobox", { name: "Link expires" });
  fireEvent.click(input);
  return input;
}

beforeEach(() => {
  nativeState.value = false;
  postMock.mockReset();
  notifyMock.mockReset();
});

describe("ShareExpiry (#335)", () => {
  it("shows the expiry date and offers the presets plus Never", async () => {
    route({});
    renderExpiry();

    expect(
      await screen.findByText(`Expires on ${expectedDate(EXPIRES)}`),
    ).toBeTruthy();
    expect(screen.getByText("Durations are counted from today.")).toBeTruthy();
    expect(postMock).toHaveBeenCalledWith("/shares/expiry/info", {
      shareId: "share-1",
    });

    await openSelect();
    const labels = screen.getAllByRole("option").map((o) => o.textContent);
    expect(labels).toEqual(["7 days", "30 days", "90 days", "1 year", "Never"]);
  });

  it("shows Never expires (and selects Never) when expiresAt is null", async () => {
    route({ info: { expiresAt: null } });
    renderExpiry();

    expect(await screen.findByText("Never expires")).toBeTruthy();
    const input = screen.getByRole("combobox", {
      name: "Link expires",
    }) as HTMLInputElement;
    expect(input.value).toBe("Never");
  });

  it("choosing a duration posts it and shows the new date", async () => {
    const renewed = "2027-12-01T10:00:00.000Z";
    route({ set: { expiresAt: renewed } });
    renderExpiry();

    await openSelect();
    fireEvent.click(screen.getByRole("option", { name: "30 days" }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/shares/expiry", {
        shareId: "share-1",
        expiresInDays: 30,
      }),
    );
    expect(
      await screen.findByText(`Expires on ${expectedDate(renewed)}`),
    ).toBeTruthy();
  });

  it("re-choosing the same duration renews (fires again)", async () => {
    route({});
    renderExpiry();

    await openSelect();
    fireEvent.click(screen.getByRole("option", { name: "90 days" }));
    await waitFor(() =>
      expect(
        postMock.mock.calls.filter((c) => c[0] === "/shares/expiry"),
      ).toHaveLength(1),
    );
    await openSelect();
    fireEvent.click(await screen.findByRole("option", { name: "90 days" }));
    await waitFor(() =>
      expect(
        postMock.mock.calls.filter((c) => c[0] === "/shares/expiry"),
      ).toHaveLength(2),
    );
  });

  it("choosing Never posts expiresInDays: null", async () => {
    route({ set: { expiresAt: null } });
    renderExpiry();

    await openSelect();
    fireEvent.click(screen.getByRole("option", { name: "Never" }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/shares/expiry", {
        shareId: "share-1",
        expiresInDays: null,
      }),
    );
    expect(await screen.findByText("Never expires")).toBeTruthy();
  });

  it("read-only users see the date but a disabled select and no hint", async () => {
    route({});
    renderExpiry({ readOnly: true });

    expect(
      await screen.findByText(`Expires on ${expectedDate(EXPIRES)}`),
    ).toBeTruthy();
    const input = screen.getByRole("combobox", {
      name: "Link expires",
    }) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(screen.queryByText("Durations are counted from today.")).toBeNull();
  });

  it("a failed change shows an error notification", async () => {
    route({ set: { status: 500 } });
    renderExpiry();

    await openSelect();
    fireEvent.click(screen.getByRole("option", { name: "7 days" }));

    await waitFor(() =>
      expect(notifyMock).toHaveBeenCalledWith(
        expect.objectContaining({ color: "red", message: "HTTP 500" }),
      ),
    );
  });

  it("renders nothing when the expiry info 404s", async () => {
    route({ info: { status: 404 } });
    const { container, client } = renderExpiry();

    await waitFor(() =>
      expect(client.getQueryState(["share-expiry", "share-1"])?.status).toBe(
        "error",
      ),
    );
    expectNothingRendered(container);
    // ...and the Publish tab is told to re-read the (now dead) share.
    await waitFor(() =>
      expect(
        calledUrls().filter((u) => u === "/shares/for-page").length,
      ).toBeGreaterThanOrEqual(2),
    );
  });

  it("renders nothing and calls nothing in native mode", async () => {
    nativeState.value = true;
    route({});
    const { container } = renderExpiry();

    await new Promise((r) => setTimeout(r, 20));
    expectNothingRendered(container);
    expect(postMock).not.toHaveBeenCalled();
  });

  it("renders nothing for an inherited share (level > 0)", async () => {
    route({ share: { ...DIRECT_SHARE, level: 1 } });
    const { container } = renderExpiry();

    await waitFor(() => expect(calledUrls()).toContain("/shares/for-page"));
    await new Promise((r) => setTimeout(r, 20));
    expectNothingRendered(container);
    expect(calledUrls()).not.toContain("/shares/expiry/info");
  });

  it("renders nothing for an unshared page", async () => {
    route({ share: null });
    const { container } = renderExpiry();

    await waitFor(() => expect(calledUrls()).toContain("/shares/for-page"));
    await new Promise((r) => setTimeout(r, 20));
    expectNothingRendered(container);
    expect(calledUrls()).not.toContain("/shares/expiry/info");
  });

  it.each([
    ["restricted", { isRestricted: true }],
    ["workspace sharing disabled", { workspaceSharingDisabled: true }],
    ["space sharing disabled", { spaceSharingDisabled: true }],
  ])("renders nothing when %s", async (_label, props) => {
    route({});
    const { container } = renderExpiry(props);

    await new Promise((r) => setTimeout(r, 20));
    expectNothingRendered(container);
    expect(calledUrls()).not.toContain("/shares/expiry/info");
  });
});
