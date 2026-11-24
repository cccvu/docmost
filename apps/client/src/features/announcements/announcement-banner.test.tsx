import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AnnouncementBanner } from "./announcement-banner";
import {
  FETCH_TIMEOUT_MS,
  fetchAnnouncement,
  shellHeaderHeight,
  useAnnouncement,
} from "./use-announcement";
import { ANNOUNCEMENT_DISMISSED_KEY } from "./announcement-storage";
import { MAX_STALE_MS } from "./announcement-schedule";

// wiki-v2 #939 — the site announcement banner, end to end through the real hook and a stubbed `fetch`, on fake
// timers (setTimeout + Date only: TanStack's 60 s poll is a setInterval and stays real, so it never fires here;
// refetches are driven explicitly; the one describe that fakes setInterval too drives the real poll). NOT upstream Docmost code.

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) =>
      k.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(o?.[name] ?? "")),
  }),
}));

const mem = new Map<string, string>();
const memStorage = {
  getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  get length() {
    return mem.size;
  },
} as Storage;

beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
});

const NOW = Date.parse("2026-11-30T12:00:00Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const norm = (s: string | null | undefined) => (s ?? "").replace(/[\u2009\u202f\u00a0]/g, " ");

interface Wire {
  version?: number;
  message?: string;
  severity?: "info" | "warning" | "critical";
  startsAt?: number | null;
  endsAt?: number | null;
  downtimeStartsAt?: number | null;
  downtimeEndsAt?: number | null;
}

function body(a: Wire | null) {
  if (a === null) return { announcement: null };
  const t = (v: number | null | undefined) => (v == null ? null : iso(v));
  return {
    announcement: {
      version: a.version ?? 1,
      message: a.message ?? "The wiki will be down for security updates.",
      severity: a.severity ?? "info",
      startsAt: t(a.startsAt),
      endsAt: t(a.endsAt),
      downtimeStartsAt: t(a.downtimeStartsAt),
      downtimeEndsAt: t(a.downtimeEndsAt),
    },
  };
}

const json = (a: Wire | null) =>
  new Response(JSON.stringify(body(a)), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

// An upcoming downtime: Dec 1, 12:00 AM CST → 3:00 AM CST.
const UPCOMING: Wire = {
  downtimeStartsAt: Date.parse("2026-12-01T06:00:00Z"),
  downtimeEndsAt: Date.parse("2026-12-01T09:00:00Z"),
};

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

/** Every call gets a fresh Response (a body can be read once). */
function respond(a: Wire | null) {
  fetchMock.mockImplementation(() => Promise.resolve(json(a)));
}
function respondOnce(a: Wire | null) {
  fetchMock.mockImplementationOnce(() => Promise.resolve(json(a)));
}

function Harness() {
  const state = useAnnouncement();
  return (
    <>
      <div data-testid="header-height">{shellHeaderHeight(state.visible)}</div>
      <AnnouncementBanner state={state} />
      <main id="main-content" tabIndex={-1} />
    </>
  );
}

let client: QueryClient;

function renderBanner() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return render(
    <QueryClientProvider client={client}>
      <MantineProvider env="test">
        <Harness />
      </MantineProvider>
    </QueryClientProvider>,
  );
}

/** Let promises and due timers run, moving the fake clock by `ms`. */
async function advance(ms = 1) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function refetch() {
  await act(async () => {
    await client.refetchQueries().catch(() => {});
  });
  await advance(1);
}

const region = () => screen.queryByRole("region");
const headerHeight = () => Number(screen.getByTestId("header-height").textContent);
const dismissButton = () => screen.queryByRole("button", { name: "Dismiss announcement" });
/** The text a screen reader can reach: everything outside `aria-hidden` subtrees. */
const spokenText = (el: Element) => {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll('[aria-hidden="true"]').forEach((e) => e.remove());
  return norm(copy.textContent);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(NOW);
  mem.clear();
  vi.stubGlobal("localStorage", memStorage);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  delete (window as { CONFIG?: unknown }).CONFIG;
});

afterEach(() => {
  cleanup();
  client?.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.documentElement.style.scrollPaddingTop = "";
});

describe("AnnouncementBanner", () => {
  it("fetches the public endpoint uncached, as JSON", async () => {
    respond(UPCOMING);
    renderBanner();
    await advance();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/bff/announcement");
    expect(init?.cache).toBe("no-store");
    expect((init?.headers as Record<string, string>).accept).toBe("application/json");
  });

  it("is a labelled region, never an alert", async () => {
    respond(UPCOMING);
    renderBanner();
    await advance();
    expect(screen.getByRole("region", { name: "Scheduled maintenance" }).tagName).toBe("SECTION");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the label, the start time and the message on the strip, and adds its height to the header", async () => {
    respond(UPCOMING);
    renderBanner();
    await advance();
    const text = norm(region()?.textContent);
    expect(text).toContain("Scheduled maintenance");
    expect(text).toContain("Starts Dec 1, 2026, 12:00 AM CST");
    expect(text).toContain("The wiki will be down for security updates.");
    expect(headerHeight()).toBe(56 + 40);
    expect(document.documentElement.style.scrollPaddingTop).toBe("var(--app-shell-header-offset, 0px)");
  });

  // #946: narrow screens show a short time (no year) instead of the message. The short form is a visual duplicate:
  // a screen reader hears the full time once, and the message, at every width.
  it("adds a short time for narrow screens that screen readers skip; they hear the full time once", async () => {
    respond(UPCOMING);
    renderBanner();
    await advance();
    const r = region()!;
    const heard = spokenText(r);
    expect(heard).toContain("Starts Dec 1, 2026, 12:00 AM CST");
    expect(heard.match(/Starts/g)).toHaveLength(1);
    expect(heard).toContain("The wiki will be down for security updates.");
    const hidden = [...r.querySelectorAll('[aria-hidden="true"]')].map((e) => norm(e.textContent));
    expect(hidden).toContain("Starts Dec 1, 12:00 AM CST");
  });

  it("in progress: the short end time is skipped too, and the full one is heard once", async () => {
    respond({ downtimeStartsAt: NOW - MIN, downtimeEndsAt: Date.parse("2026-12-01T08:00:00Z") });
    renderBanner();
    await advance();
    const r = screen.getByRole("region", { name: "Maintenance in progress" });
    const heard = spokenText(r);
    expect(heard).toContain("Until Dec 1, 2026, 2:00 AM CST");
    expect(heard.match(/Until/g)).toHaveLength(1);
    const hidden = [...r.querySelectorAll('[aria-hidden="true"]')].map((e) => norm(e.textContent));
    expect(hidden).toContain("Until Dec 1, 2:00 AM CST");
  });

  it("shows nothing (and the plain header height) for a null announcement", async () => {
    respond(null);
    renderBanner();
    await advance();
    expect(region()).toBeNull();
    expect(headerHeight()).toBe(56);
    expect(document.documentElement.style.scrollPaddingTop).toBe("");
  });

  it("Details shows the full message and the downtime lines", async () => {
    const long = "Security updates. ".repeat(20).trim();
    respond({ ...UPCOMING, message: long });
    renderBanner();
    await advance();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    await advance(500);
    const dialog = screen.getByRole("dialog");
    const text = norm(dialog.textContent);
    expect(text).toContain(long);
    expect(text).toContain("Downtime starts: Dec 1, 2026, 12:00 AM CST");
    expect(text).toContain("Downtime ends: 3:00 AM CST");
    expect(text).toContain("Expected duration: 3 hours");
  });

  it("dismissal is per version: it hides this version, focuses main, and a new version shows again", async () => {
    respond({ ...UPCOMING, version: 4 });
    renderBanner();
    await advance();
    fireEvent.click(dismissButton()!);
    expect(region()).toBeNull();
    expect(headerHeight()).toBe(56);
    expect(document.activeElement?.id).toBe("main-content");
    expect(JSON.parse(mem.get(ANNOUNCEMENT_DISMISSED_KEY)!)).toEqual({ version: 4 });

    // A reload of the same version stays dismissed.
    cleanup();
    respond({ ...UPCOMING, version: 4 });
    renderBanner();
    await advance();
    expect(region()).toBeNull();

    // An edit (new version) shows again.
    respond({ ...UPCOMING, version: 5 });
    await refetch();
    expect(region()).not.toBeNull();
  });

  it("a dismissal made while upcoming stops applying when the downtime starts", async () => {
    const start = NOW + 2 * MIN;
    respond({ downtimeStartsAt: start, downtimeEndsAt: start + 60 * MIN });
    renderBanner();
    await advance();
    fireEvent.click(dismissButton()!);
    expect(region()).toBeNull();

    await advance(2 * MIN);
    expect(screen.getByRole("region", { name: "Maintenance in progress" })).toBeTruthy();
    expect(dismissButton()).toBeNull();
    expect(headerHeight()).toBe(96);
  });

  it.each([
    ["critical", { severity: "critical" as const, endsAt: NOW + 60 * MIN }],
    ["in progress", { downtimeStartsAt: NOW - MIN, downtimeEndsAt: NOW + 60 * MIN }],
  ])("%s: the banner cannot be dismissed", async (_n, wire) => {
    mem.set(ANNOUNCEMENT_DISMISSED_KEY, JSON.stringify({ version: 1 }));
    respond(wire);
    renderBanner();
    await advance();
    expect(region()).not.toBeNull(); // a stored dismissal of this version does not hide it either
    expect(dismissButton()).toBeNull();
  });

  it("hides at its end without a refetch", async () => {
    respond({ endsAt: NOW + 2 * MIN });
    renderBanner();
    await advance();
    expect(screen.getByRole("region", { name: "Notice" })).toBeTruthy();
    await advance(2 * MIN - 10);
    expect(region()).not.toBeNull();
    await advance(10);
    expect(region()).toBeNull();
    expect(headerHeight()).toBe(56);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("changes to in progress at the downtime start and says so once in the status line", async () => {
    const start = NOW + MIN;
    respond({ downtimeStartsAt: start, downtimeEndsAt: start + 90 * MIN });
    renderBanner();
    await advance();
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("");
    expect(norm(region()?.textContent)).toContain("Scheduled maintenance");

    await advance(MIN);
    expect(screen.getByRole("region", { name: "Maintenance in progress" })).toBeTruthy();
    expect(norm(region()?.textContent)).toContain("Until");
    expect(screen.getByRole("status").textContent).toContain("Maintenance has started.");
  });

  it("keeps the SAME status node through a dismissal and the downtime start, so the message is announced", async () => {
    const start = NOW + 2 * MIN;
    respond({ downtimeStartsAt: start, downtimeEndsAt: start + 60 * MIN });
    renderBanner();
    await advance();
    const status = screen.getByRole("status");
    fireEvent.click(dismissButton()!);
    expect(region()).toBeNull();
    expect(screen.getByRole("status")).toBe(status); // hidden strip: the same live region

    await advance(2 * MIN);
    expect(region()).not.toBeNull();
    expect(screen.getByRole("status")).toBe(status); // shown again: still the same live region
    expect(status.isConnected).toBe(true);
    expect(status.textContent).toContain("Maintenance has started.");
  });

  it("an announcement already in progress on load says nothing in the status line", async () => {
    respond({ downtimeStartsAt: NOW - MIN, downtimeEndsAt: NOW + 60 * MIN });
    renderBanner();
    await advance();
    expect(region()).not.toBeNull();
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("does not show before its start, then shows at it", async () => {
    respond({ startsAt: NOW + MIN, endsAt: NOW + 3 * MIN });
    renderBanner();
    await advance();
    expect(region()).toBeNull();
    await advance(MIN);
    expect(region()).not.toBeNull();
  });

  it.each([
    ["a 503", () => new Response("busy", { status: 503 })],
    ["a 404", () => new Response("not found", { status: 404 })],
    [
      "the SPA fallback (200 text/html)",
      () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }),
    ],
    ["a network error", () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("after %s it keeps the last good answer for up to 5 minutes, then hides", async (_n, failure) => {
    respondOnce({ endsAt: NOW + 60 * MIN });
    renderBanner();
    await advance();
    expect(region()).not.toBeNull();

    fetchMock.mockImplementation(() => Promise.resolve().then(failure) as Promise<Response>);
    await advance(MIN);
    await refetch();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(region()).not.toBeNull();

    await advance(MAX_STALE_MS - MIN - 10);
    expect(region()).not.toBeNull();
    await advance(10);
    expect(region()).toBeNull();
    expect(headerHeight()).toBe(56);
  });

  describe("a stale answer while a refetch is in flight", () => {
    let settle: (r: Response) => void;
    const pending = () =>
      fetchMock.mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            settle = resolve;
          }),
      );

    async function staleThenRefetching() {
      respond({ endsAt: NOW + 60 * MIN });
      renderBanner();
      await advance();
      await advance(MAX_STALE_MS + MIN);
      expect(region()).toBeNull(); // older than 5 minutes, nothing in flight
      pending();
      act(() => {
        void client.refetchQueries().catch(() => {});
      });
      await advance(1);
    }

    it("stays visible while the refetch runs, then hides when it fails", async () => {
      await staleThenRefetching();
      expect(region()).not.toBeNull();
      expect(headerHeight()).toBe(96);
      await act(async () => settle(new Response("busy", { status: 503 })));
      await advance(1);
      expect(region()).toBeNull();
      expect(headerHeight()).toBe(56);
    });

    it("after a failed refetch, the next in-flight refetch does not bring the stale strip back", async () => {
      await staleThenRefetching();
      await act(async () => settle(new Response("busy", { status: 503 })));
      await advance(1);
      expect(region()).toBeNull();

      pending();
      act(() => {
        void client.refetchQueries().catch(() => {});
      });
      await advance(1);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(region()).toBeNull(); // in flight again, but a refetch already failed: no grace
      expect(headerHeight()).toBe(56);

      await act(async () => settle(json({ endsAt: NOW + 60 * MIN })));
      await advance(1);
      expect(region()).not.toBeNull(); // a good answer shows it again
    });

    it("stays visible while the refetch runs, and keeps it when it succeeds", async () => {
      await staleThenRefetching();
      expect(region()).not.toBeNull();
      await act(async () => settle(json({ endsAt: NOW + 60 * MIN })));
      await advance(1);
      expect(region()).not.toBeNull();
      await advance(4 * MIN);
      expect(region()).not.toBeNull(); // the good answer renewed the 5 minutes
    });
  });

  it("a refetch that never answers is aborted at 10 s, and the stale answer then hides", async () => {
    respond({ endsAt: NOW + 60 * MIN });
    renderBanner();
    await advance();
    await advance(MAX_STALE_MS + MIN);
    expect(region()).toBeNull();

    // A request that never answers on its own: like the real fetch, it rejects only when its signal aborts.
    let seen: AbortSignal | undefined;
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          seen = init?.signal ?? undefined;
          seen?.addEventListener("abort", () => reject(seen?.reason), { once: true });
        }),
    );
    act(() => {
      void client.refetchQueries().catch(() => {});
    });
    await advance(1);
    expect(region()).not.toBeNull(); // in flight: still shown
    await advance(FETCH_TIMEOUT_MS - 10);
    expect(seen?.aborted).toBe(false);
    expect(region()).not.toBeNull();
    await advance(10);
    expect(seen?.aborted).toBe(true);
    expect((seen?.reason as DOMException).name).toBe("TimeoutError");
    expect(region()).toBeNull();
    expect(headerHeight()).toBe(56);
  });

  describe.each([
    ["with AbortSignal.any", false],
    ["without AbortSignal.any (fallback)", true],
  ])("fetchAnnouncement's deadline %s", (_n, removeAny) => {
    let saved: unknown;
    beforeEach(() => {
      saved = (AbortSignal as { any?: unknown }).any;
      if (removeAny) (AbortSignal as { any?: unknown }).any = undefined;
    });
    afterEach(() => {
      (AbortSignal as { any?: unknown }).any = saved;
    });

    const hang = () => {
      let seen: AbortSignal | undefined;
      fetchMock.mockImplementation(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            seen = init?.signal ?? undefined;
            seen?.addEventListener("abort", () => reject(seen?.reason), { once: true });
          }),
      );
      return () => seen;
    };

    it("rejects with a TimeoutError at 10 s", async () => {
      const seen = hang();
      const outcome = fetchAnnouncement(new AbortController().signal).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS);
      expect(((await outcome) as DOMException).name).toBe("TimeoutError");
      expect(seen()?.aborted).toBe(true);
    });

    it("still honours the caller's cancellation", async () => {
      const seen = hang();
      const caller = new AbortController();
      const outcome = fetchAnnouncement(caller.signal).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1);
      caller.abort(new DOMException("cancelled", "AbortError"));
      expect(((await outcome) as DOMException).name).toBe("AbortError");
      expect(seen()?.aborted).toBe(true);
    });
  });

  it("a tab hidden past the limit keeps its strip on return while the focus refetch runs (no hide-and-show)", async () => {
    let hidden = false;
    const spy = vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
      hidden ? "hidden" : "visible",
    );
    try {
      respond({ endsAt: NOW + 60 * MIN });
      renderBanner();
      await advance();
      hidden = true;
      document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
      await advance(MAX_STALE_MS + MIN); // the staleness timer fires while hidden and changes nothing
      expect(region()).not.toBeNull();

      let settle!: (r: Response) => void;
      fetchMock.mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            settle = resolve;
          }),
      );
      hidden = false;
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
      });
      expect(region()).not.toBeNull();
      await advance(1); // the deferred re-read of the clock: stale, but the focus refetch is in flight
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(region()).not.toBeNull();

      await act(async () => settle(new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } })));
      await advance(1);
      expect(region()).toBeNull(); // the refetch failed: the stale answer hides
    } finally {
      spy.mockRestore();
    }
  });

  describe("the 60 s poll against a platform that keeps failing", () => {
    beforeEach(() => {
      vi.useRealTimers();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
      vi.setSystemTime(NOW);
    });

    const hangUntilAborted = () =>
      fetchMock.mockImplementation(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            const seen = init?.signal ?? undefined;
            seen?.addEventListener("abort", () => reject(seen?.reason), { once: true });
          }),
      );
    const slow503 = () =>
      fetchMock.mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            setTimeout(() => resolve(new Response("busy", { status: 503 })), 2_000);
          }),
      );

    it.each([
      ["hangs (each poll aborted at 10 s)", hangUntilAborted],
      ["answers 503 after 2 s", slow503],
    ])("never shows the stale strip again once it has hidden, when the platform %s", async (_n, failing) => {
      respondOnce({ endsAt: NOW + 60 * MIN });
      renderBanner();
      await advance();
      expect(region()).not.toBeNull();
      failing();

      // Every poll fails; the strip hides once the answer is older than 5 minutes (plus at most one deadline).
      await advance(MAX_STALE_MS + FETCH_TIMEOUT_MS);
      expect(region()).toBeNull();
      const polls = fetchMock.mock.calls.length;

      // Then, through several more polls (each one in flight for a while), it never comes back.
      for (let elapsed = 0; elapsed < 5 * MIN; elapsed += 1_000) {
        await advance(1_000);
        expect(region()).toBeNull();
        expect(headerHeight()).toBe(56);
      }
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(polls + 4); // the poll really ran
    });
  });

  it("a good refetch renews the 5 minutes", async () => {
    respond({ endsAt: NOW + 60 * MIN });
    renderBanner();
    await advance();
    await advance(4 * MIN);
    await refetch();
    await advance(4 * MIN);
    expect(region()).not.toBeNull();
  });

  it("a later null answer hides it", async () => {
    respond({ endsAt: NOW + 60 * MIN });
    renderBanner();
    await advance();
    expect(region()).not.toBeNull();
    respond(null);
    await refetch();
    expect(region()).toBeNull();
  });

  it("native (standalone) mode makes no request", async () => {
    (window as { CONFIG?: unknown }).CONFIG = { NATIVE_AUTH_ENABLED: true };
    respond(UPCOMING);
    renderBanner();
    await advance(5 * MIN);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(region()).toBeNull();
  });
});
