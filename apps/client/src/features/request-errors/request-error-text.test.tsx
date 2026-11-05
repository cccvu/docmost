import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { AxiosError, AxiosHeaders } from "axios";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      key.replace(/{{(\w+)}}/g, (_m, name: string) =>
        String(options?.[name] ?? ""),
      ),
  }),
}));

import { RequestErrorText } from "./request-error-text";

// MantineProvider reads matchMedia for the color scheme; jsdom has none.
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

function httpError(status: number, headers: Record<string, string> = {}) {
  return new AxiosError(
    "Request failed",
    "ERR_BAD_REQUEST",
    undefined,
    {},
    {
      status,
      statusText: "",
      data: "<html/>",
      headers: AxiosHeaders.from(headers),
      config: { headers: new AxiosHeaders() },
    },
  );
}

function renderText(error: unknown) {
  return render(
    <MantineProvider>
      <RequestErrorText error={error} fallback="Failed to fetch recent pages" />
    </MantineProvider>,
  );
}

describe("RequestErrorText (#384)", () => {
  it("says a rate limit is a rate limit, not 'Failed to fetch'", () => {
    renderText(httpError(429, { "Retry-After": "10" }));
    expect(
      screen.getByText(
        "Too many requests. Please wait about 10 seconds, then try again.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Failed to fetch/)).toBeNull();
  });

  it("keeps the page's own text for any other failure, with the status", () => {
    renderText(httpError(500));
    const el = screen.getByText("Failed to fetch recent pages (HTTP 500)");
    // Same bare Mantine Text the call sites rendered before: a <p class="mantine-Text-root">.
    expect(el.tagName).toBe("P");
    expect(el.className).toContain("mantine-Text-root");
  });

  it("renders the bare fallback for a non-HTTP error", () => {
    renderText(new Error("boom"));
    expect(screen.getByText("Failed to fetch recent pages")).toBeTruthy();
  });
});
