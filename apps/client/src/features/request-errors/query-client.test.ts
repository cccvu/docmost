import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AxiosError, AxiosHeaders } from "axios";
import { notificationsStore } from "@mantine/notifications";

// Real i18n isn't loaded in unit tests; the app falls back to the key.
vi.mock("i18next", () => ({
  default: {
    t: (key: string, options?: Record<string, unknown>) =>
      key.replace(/{{(\w+)}}/g, (_m, name: string) =>
        String(options?.[name] ?? ""),
      ),
  },
}));

import {
  createAppQueryClient,
  MAX_AUTO_RETRY_AFTER_MS,
  queryRetryDelay,
  RATE_LIMITED_NOTIFICATION_ID,
  shouldRetryQuery,
} from "./query-client";

function httpError(
  status: number,
  headers: Record<string, string> = {},
  data: unknown = {},
) {
  return new AxiosError(
    "Request failed",
    "ERR_BAD_REQUEST",
    undefined,
    {},
    {
      status,
      statusText: "",
      data,
      headers: AxiosHeaders.from(headers),
      config: { headers: new AxiosHeaders() },
    },
  );
}
const limited = (seconds?: string) =>
  httpError(429, seconds === undefined ? {} : { "Retry-After": seconds });

function shownRateLimitToasts() {
  const { notifications, queue } = notificationsStore.getState();
  return [...notifications, ...queue].filter(
    (n) => n.id === RATE_LIMITED_NOTIFICATION_ID,
  );
}

beforeEach(() => {
  notificationsStore.setState({
    ...notificationsStore.getState(),
    notifications: [],
    queue: [],
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("shouldRetryQuery (#384)", () => {
  it.each<[string, number, unknown, boolean]>([
    ["429, Retry-After 10, first failure", 0, limited("10"), true],
    ["429, Retry-After 1, first failure", 0, limited("1"), true],
    ["429, Retry-After 10, after the one retry", 1, limited("10"), false],
    ["429, Retry-After 11 (over the cap)", 0, limited("11"), false],
    ["429, Retry-After 60 (WAF)", 0, limited("60"), false],
    ["429, no Retry-After", 0, limited(), false],
    [
      "429, HTTP-date Retry-After",
      0,
      limited("Wed, 21 Oct 2026 07:28:00 GMT"),
      false,
    ],
    [
      "503 with Retry-After 5",
      0,
      httpError(503, { "Retry-After": "5" }),
      false,
    ],
    ["500", 0, httpError(500), false],
    ["network error", 0, new AxiosError("Network Error", "ERR_NETWORK"), false],
    ["non-axios Error", 0, new Error("boom"), false],
  ])("%s -> %s", (_name, failureCount, error, expected) => {
    expect(shouldRetryQuery(failureCount, error)).toBe(expected);
  });

  it("caps at the fork limiter's 10 s block", () => {
    expect(MAX_AUTO_RETRY_AFTER_MS).toBe(10_000);
  });
});

describe("queryRetryDelay (#384)", () => {
  it.each([0, 0.5, 0.999999])(
    "is Retry-After + [0, 1000) ms (random=%s)",
    (r) => {
      vi.spyOn(Math, "random").mockReturnValue(r);
      const delay = queryRetryDelay(0, limited("10"));
      expect(delay).toBeGreaterThanOrEqual(10_000); // never earlier than the server asked
      expect(delay).toBeLessThan(11_000);
    },
  );
});

describe("createAppQueryClient (#384)", () => {
  it("keeps the app's query defaults", () => {
    const q = createAppQueryClient().getDefaultOptions().queries!;
    expect(q.refetchOnMount).toBe(false);
    expect(q.refetchOnWindowFocus).toBe(false);
    expect(q.staleTime).toBe(5 * 60 * 1000);
    expect(q.retry).toBe(shouldRetryQuery);
    expect(q.retryDelay).toBe(queryRetryDelay);
  });

  it("two rate-limited queries raise ONE toast, with the server's text", async () => {
    const client = createAppQueryClient();
    const waf = httpError(
      429,
      { "Retry-After": "60" },
      {
        message:
          "Too many requests from your network. Please wait a minute, then try again.",
      },
    );
    const fail = () => Promise.reject(waf);
    await Promise.allSettled([
      client.fetchQuery({ queryKey: ["a"], queryFn: fail }),
      client.fetchQuery({ queryKey: ["b"], queryFn: fail }),
    ]);

    const toasts = shownRateLimitToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe(
      "Too many requests from your network. Please wait a minute, then try again.",
    );
    expect(toasts[0].title).toBe("Too many requests");
  });

  it("does not toast a non-429 failure (the page's own error text covers it)", async () => {
    const client = createAppQueryClient();
    await client
      .fetchQuery({
        queryKey: ["x"],
        queryFn: () => Promise.reject(httpError(500)),
      })
      .catch(() => {});
    expect(shownRateLimitToasts()).toHaveLength(0);
  });

  it("does not toast a failed mutation (mutations keep their own toasts)", async () => {
    const client = createAppQueryClient();
    await client
      .getMutationCache()
      .build(client, { mutationFn: () => Promise.reject(limited("60")) })
      .execute(undefined)
      .catch(() => {});
    expect(shownRateLimitToasts()).toHaveLength(0);
  });

  it("retries a short 429 exactly once, after Retry-After, then succeeds without a toast", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const client = createAppQueryClient();
    const queryFn = vi
      .fn()
      .mockRejectedValueOnce(limited("2"))
      .mockResolvedValueOnce("ok");

    const result = client.fetchQuery({ queryKey: ["r"], queryFn });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(queryFn).toHaveBeenCalledTimes(1); // not before Retry-After
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("ok");
    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(shownRateLimitToasts()).toHaveLength(0);
  });

  it("a persistent short 429 is tried twice in total, then toasts once", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const client = createAppQueryClient();
    const queryFn = vi.fn().mockRejectedValue(limited("2"));

    const result = client
      .fetchQuery({ queryKey: ["p"], queryFn })
      .catch((e) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    await result;
    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(shownRateLimitToasts()).toHaveLength(1);
  });

  it("an explicit per-query retry still wins over the default", async () => {
    const client = createAppQueryClient();
    const queryFn = vi.fn().mockRejectedValue(limited("2"));
    await client
      .fetchQuery({ queryKey: ["e"], queryFn, retry: false })
      .catch(() => {});
    expect(queryFn).toHaveBeenCalledTimes(1);
  });
});
