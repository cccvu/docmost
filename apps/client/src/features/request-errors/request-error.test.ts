import { describe, expect, it } from "vitest";
import { AxiosError, AxiosHeaders } from "axios";
import {
  errorStatus,
  isRateLimited,
  requestErrorMessage,
  retryAfterMs,
  type Translate,
} from "./request-error";

// English literals with i18next-style interpolation (the app falls back to the key).
const t: Translate = (key, options) =>
  key.replace(/{{(\w+)}}/g, (_m, name: string) =>
    String(options?.[name] ?? ""),
  );

const FALLBACK = "Failed to fetch recent pages";
const WAF_MESSAGE =
  "Too many requests from your network. Please wait a minute, then try again.";

// A real AxiosError, as the api client rejects with; headers go through AxiosHeaders like the XHR adapter's.
function httpError(
  status: number,
  data: unknown = {},
  headers: Record<string, string> = {},
): AxiosError {
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

function networkError(): AxiosError {
  return new AxiosError("Network Error", "ERR_NETWORK", undefined, {});
}

describe("errorStatus / isRateLimited (#384)", () => {
  it.each([
    [httpError(429), 429, true],
    [httpError(403), 403, false],
    [httpError(500), 500, false],
    [networkError(), null, false],
    [new Error("boom"), null, false],
    [{ response: { status: 429 } }, null, false], // not an AxiosError: never guessed at
    [undefined, null, false],
  ])("%#", (error, status, limited) => {
    expect(errorStatus(error)).toBe(status);
    expect(isRateLimited(error)).toBe(limited);
  });
});

describe("retryAfterMs (#384)", () => {
  it.each([
    ["10", 10_000],
    ["60", 60_000],
    [" 5 ", 5_000],
    ["0", null],
    ["-5", null],
    ["1.5", null],
    ["abc", null],
    ["", null],
    ["Wed, 21 Oct 2026 07:28:00 GMT", null], // HTTP-date: nothing in front of the wiki sends one
  ])("Retry-After %j -> %j", (header, expected) => {
    expect(retryAfterMs(httpError(429, {}, { "Retry-After": header }))).toBe(
      expected,
    );
  });

  it("is null without the header, without a response, or for a non-axios error", () => {
    expect(retryAfterMs(httpError(429))).toBeNull();
    expect(retryAfterMs(networkError())).toBeNull();
    expect(retryAfterMs(new Error("boom"))).toBeNull();
  });

  it("reads a plain-object header bag too (lower-cased, as axios normalizes)", () => {
    const err = httpError(429);
    err.response!.headers = { "retry-after": "7" } as never;
    expect(retryAfterMs(err)).toBe(7_000);
  });
});

describe("requestErrorMessage (#384)", () => {
  it.each<[string, unknown, string]>([
    [
      "429 WAF body + Retry-After: 60 -> the WAF's own sentence",
      httpError(
        429,
        { error: "rate_limited", message: WAF_MESSAGE },
        { "Retry-After": "60" },
      ),
      WAF_MESSAGE,
    ],
    [
      "429 Nest body -> its string message",
      httpError(
        429,
        { statusCode: 429, message: "Too many requests" },
        { "Retry-After": "10" },
      ),
      "Too many requests",
    ],
    [
      "429 HTML body + Retry-After -> the wait-N-seconds text",
      httpError(429, "<html><body>429</body></html>", { "Retry-After": "10" }),
      "Too many requests. Please wait about 10 seconds, then try again.",
    ],
    [
      "429 array message -> not a sentence, the wait text",
      httpError(429, { message: ["a", "b"] }, { "Retry-After": "3" }),
      "Too many requests. Please wait about 3 seconds, then try again.",
    ],
    [
      "429 blank message, no Retry-After -> wait a minute",
      httpError(429, { message: "   " }),
      "Too many requests. Please wait a minute, then try again.",
    ],
    [
      "429 HTTP-date Retry-After -> wait a minute",
      httpError(429, "", { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" }),
      "Too many requests. Please wait a minute, then try again.",
    ],
    ["403", httpError(403, { message: "Forbidden" }), `${FALLBACK} (HTTP 403)`],
    ["404", httpError(404), `${FALLBACK} (HTTP 404)`],
    ["500", httpError(500, "<html/>"), `${FALLBACK} (HTTP 500)`],
    ["503", httpError(503), `${FALLBACK} (HTTP 503)`],
    [
      "network error (no response)",
      networkError(),
      "Can't reach the wiki. Check your connection and try again.",
    ],
    [
      "cancelled request is not 'offline'",
      new AxiosError("canceled", "ERR_CANCELED"),
      FALLBACK,
    ],
    ["non-axios Error", new Error("boom"), FALLBACK],
  ])("%s", (_name, error, expected) => {
    expect(requestErrorMessage(error, t, FALLBACK)).toBe(expected);
  });

  it("clamps a long 429 server message to 200 characters", () => {
    const long = "x".repeat(500);
    const out = requestErrorMessage(
      httpError(429, { message: long }),
      t,
      FALLBACK,
    );
    expect(out).toHaveLength(200);
    expect(out.endsWith("…")).toBe(true);
  });
});
