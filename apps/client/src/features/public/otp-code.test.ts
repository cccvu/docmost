import { describe, expect, it } from "vitest";
import {
  hasMinimumDigits,
  isBulkEntry,
  isCompleteOtp,
  normalizeOtp,
  tooManyRequestsMessage,
} from "./otp-code";

// wiki-v2 #815: the code is moving from 6 to 8 digits one release after this field ships, so the field takes 6 to 12
// digits and ignores the separators the email groups it with.

const t = (key: string, options?: Record<string, unknown>) =>
  key.replace(/{{(\w+)}}/g, (_, name: string) => String(options?.[name]));

const http429 = (headers: Record<string, string> = {}) =>
  Object.assign(new Error("HTTP 429"), {
    isAxiosError: true,
    response: { status: 429, headers, data: {} },
  });

describe("otp-code", () => {
  it("strips spaces and hyphens, nothing else", () => {
    expect(normalizeOtp("1234 5678")).toBe("12345678");
    expect(normalizeOtp(" 1234-5678 ")).toBe("12345678");
    expect(normalizeOtp("12a4")).toBe("12a4");
  });

  it.each([
    ["123456", true],
    ["1234 5678", true],
    ["1234-5678", true],
    ["123456789012", true],
    ["12345", false],
    ["1234567890123", false],
    ["12345a", false],
    ["", false],
  ])("isCompleteOtp(%j) = %s", (raw, ok) => {
    expect(isCompleteOtp(raw)).toBe(ok);
  });

  it("offers submit from the sixth digit", () => {
    expect(hasMinimumDigits("12 345")).toBe(false);
    expect(hasMinimumDigits("123 456")).toBe(true);
  });

  it("calls a paste, drop or autofill bulk, and typing never", () => {
    expect(isBulkEntry("", "12345678", "insertFromPaste")).toBe(true);
    // Select-all and paste over a code of the same length: no length jump, the input type alone says paste.
    expect(isBulkEntry("111111", "222222", "insertFromPaste")).toBe(true);
    expect(isBulkEntry("", "123456", "insertReplacementText")).toBe(true);
    // An autofill that reports no input type at all.
    expect(isBulkEntry("", "123456", undefined)).toBe(true);
    // Typing: one character per event, whatever the length reached.
    expect(isBulkEntry("12345", "123456", "insertText")).toBe(false);
    expect(isBulkEntry("1234567", "12345678", undefined)).toBe(false);
    expect(isBulkEntry("123456", "12345", "deleteContentBackward")).toBe(false);
  });

  it("429: the plain wait without Retry-After, and the server's wait with it", () => {
    expect(tooManyRequestsMessage(http429(), t)).toBe(
      "Too many requests. Wait a few minutes, then try again.",
    );
    expect(tooManyRequestsMessage(http429({ "retry-after": "30" }), t)).toBe(
      "Too many requests. Wait 30 seconds, then try again.",
    );
    expect(tooManyRequestsMessage(http429({ "retry-after": "300" }), t)).toBe(
      "Too many requests. Wait 5 minutes, then try again.",
    );
    // An HTTP-date (or junk) is not guessed at.
    expect(
      tooManyRequestsMessage(
        http429({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }),
        t,
      ),
    ).toBe("Too many requests. Wait a few minutes, then try again.");
  });
});
