import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AdminEntryLink } from "./admin-entry-link";
import { PLATFORM_ADMIN_SEEN_KEY } from "./use-platform-admin-context";

// The component reads platform admin state from platformApi.get("/admin/context").
const getMock = vi.fn();
vi.mock("@/lib/platform-client", () => ({ default: { get: (...a: unknown[]) => getMock(...a) } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const memStore = new Map<string, string>();
const memLocalStorage = {
  getItem: (k: string) => (memStore.has(k) ? (memStore.get(k) as string) : null),
  setItem: (k: string, v: string) => void memStore.set(k, String(v)),
  removeItem: (k: string) => void memStore.delete(k),
  clear: () => memStore.clear(),
  key: (i: number) => Array.from(memStore.keys())[i] ?? null,
  get length() {
    return memStore.size;
  },
} as Storage;

beforeAll(() => {
  // jsdom/Node in this runner does not expose a working global localStorage; provide an in-memory one.
  vi.stubGlobal("localStorage", memLocalStorage);
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

beforeEach(() => {
  getMock.mockReset();
  memStore.clear();
});

function renderLink() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const utils = render(
    <QueryClientProvider client={client}>
      <MantineProvider>
        <MemoryRouter>
          <AdminEntryLink />
        </MemoryRouter>
      </MantineProvider>
    </QueryClientProvider>,
  );
  return { client, ...utils };
}

function hrefs() {
  return screen.queryAllByRole("link").map((l) => l.getAttribute("href") ?? "");
}

describe("AdminEntryLink", () => {
  it("shows the /console link and remembers the admin hint when isAdmin is true", async () => {
    getMock.mockResolvedValue({ data: { isAdmin: true } });
    renderLink();
    await waitFor(() => expect(hrefs()).toContain("/console"));
    // no re-auth affordance, and the advisory hint is persisted
    expect(hrefs().some((h) => h.startsWith("/login"))).toBe(false);
    expect(localStorage.getItem(PLATFORM_ADMIN_SEEN_KEY)).toBe("1");
  });

  it("renders nothing for a genuine non-admin (200 isAdmin:false)", async () => {
    getMock.mockResolvedValue({ data: { isAdmin: false } });
    renderLink();
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await waitFor(() => expect(hrefs()).toHaveLength(0));
    expect(localStorage.getItem(PLATFORM_ADMIN_SEEN_KEY)).toBeNull();
  });

  it("shows a re-authenticate affordance (not the console link) on a 401 when the browser was previously an admin", async () => {
    localStorage.setItem(PLATFORM_ADMIN_SEEN_KEY, "1");
    getMock.mockRejectedValue({ response: { status: 401 } });
    renderLink();
    await waitFor(() => expect(hrefs().some((h) => h.startsWith("/login"))).toBe(true));
    // it must NOT surface a live console link when the session is gone
    expect(hrefs()).not.toContain("/console");
  });

  it("treats a transient 5xx as recoverable and shows the re-auth affordance when previously admin", async () => {
    localStorage.setItem(PLATFORM_ADMIN_SEEN_KEY, "1");
    getMock.mockRejectedValue({ response: { status: 503 } });
    renderLink();
    await waitFor(() => expect(hrefs().some((h) => h.startsWith("/login"))).toBe(true));
  });

  it("renders nothing on a 401 when the browser has no admin hint (a non-admin session lapse)", async () => {
    getMock.mockRejectedValue({ response: { status: 401 } });
    renderLink();
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await waitFor(() => expect(hrefs()).toHaveLength(0));
  });

  it("keeps the /console link on a transient background-refetch failure (a blip must not blank it)", async () => {
    getMock.mockResolvedValue({ data: { isAdmin: true } });
    const { client } = renderLink();
    await waitFor(() => expect(hrefs()).toContain("/console"));
    // A background refetch now fails (transient 5xx). react-query v5 keeps the last-good data, so the
    // gate stays "admin" — the whole point of gcTime:Infinity + retained data.
    getMock.mockRejectedValue({ response: { status: 503 } });
    await client.refetchQueries({ queryKey: ["platform-admin-context"] }).catch(() => {});
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));
    expect(hrefs()).toContain("/console");
    expect(hrefs().some((h) => h.startsWith("/login"))).toBe(false);
  });

  it("shows the re-auth affordance on a network error (no response) when previously an admin", async () => {
    localStorage.setItem(PLATFORM_ADMIN_SEEN_KEY, "1");
    getMock.mockRejectedValue(new Error("Network Error")); // no .response → recoverable
    renderLink();
    await waitFor(() => expect(hrefs().some((h) => h.startsWith("/login"))).toBe(true));
  });

  it("renders nothing on a NON-recoverable error (e.g. 404), even with an admin hint", async () => {
    localStorage.setItem(PLATFORM_ADMIN_SEEN_KEY, "1");
    getMock.mockRejectedValue({ response: { status: 404 } });
    renderLink();
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await waitFor(() => expect(hrefs()).toHaveLength(0));
  });

  it("clears the admin hint on a genuine 200 isAdmin:false (a demoted admin stops seeing re-auth)", async () => {
    localStorage.setItem(PLATFORM_ADMIN_SEEN_KEY, "1");
    getMock.mockResolvedValue({ data: { isAdmin: false } });
    renderLink();
    await waitFor(() => expect(localStorage.getItem(PLATFORM_ADMIN_SEEN_KEY)).toBeNull());
    expect(hrefs()).toHaveLength(0);
  });
});
