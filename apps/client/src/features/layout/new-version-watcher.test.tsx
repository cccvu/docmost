import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import type { ReactNode } from "react";

const show = vi.fn();
vi.mock("@mantine/notifications", () => ({ notifications: { show: (o: unknown) => show(o) } }));
// The catalog is not loaded in unit tests; echo the key (the en-US value equals it).
vi.mock("i18next", () => ({ default: { t: (key: string) => key } }));

import {
  NEW_VERSION_NOTIFICATION_ID,
  runningEntrySrc,
  showNewVersionNotification,
  startNewVersionWatcher,
} from "./new-version-watcher";
import { NEW_VERSION_PROBE_INTERVAL_MS } from "./new-version-check";

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

afterEach(() => {
  cleanup();
  show.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const html = (hash: string) =>
  `<!doctype html><html><head><script type="module" crossorigin src="/assets/index-${hash}.js"></script></head></html>`;

describe("runningEntrySrc", () => {
  it("is null under the Vite dev server's unhashed entry", () => {
    const doc = document.implementation.createHTMLDocument("x");
    doc.head.innerHTML = `<script type="module" src="/src/main.tsx"></script>`;
    expect(runningEntrySrc(doc)).toBeNull();
  });

  it("reads the built, hashed entry", () => {
    const doc = document.implementation.createHTMLDocument("x");
    doc.head.innerHTML = `<link rel="modulepreload" href="/assets/v-1.js"><script type="module" crossorigin src="/assets/index-abc.js"></script>`;
    expect(runningEntrySrc(doc)).toBe("/assets/index-abc.js");
  });
});

describe("showNewVersionNotification", () => {
  it("shows one persistent notification whose Reload action reloads the page", () => {
    const reload = vi.fn();
    showNewVersionNotification(reload);
    expect(show).toHaveBeenCalledTimes(1);
    const opts = show.mock.calls[0][0] as { id: string; autoClose: unknown; message: ReactNode };
    expect(opts.id).toBe(NEW_VERSION_NOTIFICATION_ID);
    expect(opts.autoClose).toBe(false);
    render(<MantineProvider>{opts.message}</MantineProvider>);
    expect(screen.getByText("A new version is available")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("startNewVersionWatcher", () => {
  it("probes / on focus and visibility, and nudges once after two confirming probes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const script = document.createElement("script");
    script.type = "module";
    script.setAttribute("src", "/assets/index-old.js");
    document.head.appendChild(script);
    const fetchMock = vi.fn(
      async (_input: string, _init?: RequestInit) =>
        new Response(html("new"), { headers: { "content-type": "text/html" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const settle = () => new Promise((r) => setTimeout(r, 0));

    startNewVersionWatcher();
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/");
    expect(show).not.toHaveBeenCalled();

    vi.setSystemTime(1_000_000 + NEW_VERSION_PROBE_INTERVAL_MS);
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(show).toHaveBeenCalledTimes(1);

    vi.setSystemTime(1_000_000 + 3 * NEW_VERSION_PROBE_INTERVAL_MS);
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(show).toHaveBeenCalledTimes(1);
    script.remove();
  });
});
