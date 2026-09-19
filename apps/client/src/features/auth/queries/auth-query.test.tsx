import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AxiosError } from "axios";
import type { ReactNode } from "react";
import {
  COLLAB_TOKEN_MAX_RETRIES,
  shouldRetryCollabToken,
  collabTokenRetryDelay,
  useCollabToken,
} from "./auth-query";

// useCollabToken imports getCollabToken; mock it so the wiring test can mount the hook without a network.
vi.mock("../services/auth-service", () => ({ getCollabToken: vi.fn() }));

// axios's isAxiosError() only checks `payload.isAxiosError === true`, so plain objects are enough here.
// networkError = the shape the old predicate threw on: isAxiosError true, but NO `response`.
const networkError = () =>
  Object.assign(new Error("Network Error"), {
    isAxiosError: true,
  }) as unknown as AxiosError;
const httpError = (status: number, headers: Record<string, string> = {}) =>
  ({
    isAxiosError: true,
    message: `Request failed with status code ${status}`,
    response: { status, headers },
  }) as unknown as AxiosError;

describe("shouldRetryCollabToken (#385)", () => {
  it("retries a network error (no response) WITHOUT throwing — the cold-start race", () => {
    // The stock predicate read `error.response.status` unguarded and threw a TypeError here.
    let result: boolean | undefined;
    expect(() => {
      result = shouldRetryCollabToken(0, networkError());
    }).not.toThrow();
    expect(result).toBe(true);
  });

  it("does NOT retry deliberate refusals (403 / 404)", () => {
    expect(shouldRetryCollabToken(0, httpError(403))).toBe(false);
    expect(shouldRetryCollabToken(0, httpError(404))).toBe(false);
  });

  it("does NOT retry other 4xx client errors (400 / 401 / 409)", () => {
    for (const status of [400, 401, 409]) {
      expect(shouldRetryCollabToken(0, httpError(status))).toBe(false);
    }
  });

  it("retries a rate limit (429) and server errors (5xx)", () => {
    expect(
      shouldRetryCollabToken(0, httpError(429, { "retry-after": "60" })),
    ).toBe(true);
    expect(shouldRetryCollabToken(0, httpError(500))).toBe(true);
    expect(shouldRetryCollabToken(0, httpError(503))).toBe(true);
  });

  it("is bounded — stops at the cap (locks out the old unbounded `return 10`)", () => {
    expect(
      shouldRetryCollabToken(COLLAB_TOKEN_MAX_RETRIES - 1, httpError(503)),
    ).toBe(true);
    expect(
      shouldRetryCollabToken(COLLAB_TOKEN_MAX_RETRIES, httpError(503)),
    ).toBe(false);
    expect(
      shouldRetryCollabToken(COLLAB_TOKEN_MAX_RETRIES + 5, networkError()),
    ).toBe(false);
  });

  it("treats a non-axios error as transient, but still bounded", () => {
    expect(shouldRetryCollabToken(0, new Error("boom"))).toBe(true);
    expect(
      shouldRetryCollabToken(COLLAB_TOKEN_MAX_RETRIES, new Error("boom")),
    ).toBe(false);
  });
});

describe("collabTokenRetryDelay (#385)", () => {
  beforeEach(() => {
    // Pin the single jitter term so honored Retry-After delays are exact.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("honors Retry-After (delta-seconds) as a MINIMUM, adding jitter on top", () => {
    // 60s + 0.5*15000 = 67500; always >= the server minimum, never below it.
    expect(
      collabTokenRetryDelay(0, httpError(429, { "retry-after": "60" })),
    ).toBe(67_500);
    expect(
      collabTokenRetryDelay(0, httpError(429, { "retry-after": "60" })),
    ).toBeGreaterThanOrEqual(60_000);
  });

  it("does NOT clamp a large Retry-After down (would retry before the server minimum — the #385 bug)", () => {
    // 300s must be honored exactly (+ jitter), never shortened toward the backoff cap.
    expect(
      collabTokenRetryDelay(0, httpError(429, { "retry-after": "300" })),
    ).toBe(307_500);
    expect(
      collabTokenRetryDelay(0, httpError(503, { "retry-after": "300" })),
    ).toBeGreaterThanOrEqual(300_000);
  });

  it("falls back to capped exponential backoff when there is no usable Retry-After", () => {
    // The backoff branch has no jitter, so the pinned Math.random does not affect it.
    expect(collabTokenRetryDelay(0, httpError(503))).toBe(1_000);
    expect(collabTokenRetryDelay(1, httpError(503))).toBe(2_000);
    expect(collabTokenRetryDelay(2, networkError())).toBe(4_000);
    // A garbage header is not a finite positive number -> backoff, never NaN/negative.
    expect(
      collabTokenRetryDelay(0, httpError(429, { "retry-after": "soon" })),
    ).toBe(1_000);
  });

  it("caps the backoff at 30s for large failure counts", () => {
    expect(collabTokenRetryDelay(20, httpError(503))).toBe(30_000);
    expect(collabTokenRetryDelay(20, networkError())).toBe(30_000);
  });
});

describe("useCollabToken wiring (#385)", () => {
  it("wires the exported predicate + delay into the collab-token query", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    renderHook(() => useCollabToken(), { wrapper });

    const query = client
      .getQueryCache()
      .find({ queryKey: ["collab-token"] });
    const retry = query?.options.retry as typeof shouldRetryCollabToken;
    const retryDelay = query?.options
      .retryDelay as typeof collabTokenRetryDelay;

    // Prove the query actually uses our policy (behaviour, not reference identity).
    expect(typeof retry).toBe("function");
    expect(retry(0, httpError(403))).toBe(false); // deliberate refusal -> terminal
    expect(retry(0, networkError())).toBe(true); // cold-start race -> retry
    expect(
      retryDelay(0, httpError(429, { "retry-after": "60" })),
    ).toBeGreaterThanOrEqual(60_000); // honors Retry-After
  });
});
