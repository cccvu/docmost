import { isAxiosError } from "axios";
import {
  errorStatus,
  requestErrorMessage,
  retryAfterMs,
  type Translate,
} from "@/features/request-errors/request-error";

/**
 * What a failed `POST /v1/feedback` means for the reporter. Each kind maps to one inline message in the
 * modal (never a toast). House rule: a 503 means nothing was sent; a 504 means it may have been sent, and
 * a same-key retry never sends it twice.
 */
export type FeedbackFailure =
  | { kind: "unauthenticated" }
  | { kind: "rate_limited"; waitSeconds: number | null; detail: string | null }
  | { kind: "outcome_unknown" }
  | { kind: "unavailable" }
  | { kind: "blocked" }
  | { kind: "other"; message: string };

// The server's `detail` is untrusted text shown verbatim (as React text), so bound it.
const MAX_DETAIL_CHARS = 200;

/**
 * The `code` of an RFC 7807 body from the platform, or null when the response is not problem+json — e.g.
 * the WAF's HTML block page or a proxy's error page.
 */
export function problemCode(error: unknown): string | null {
  if (!isAxiosError(error) || !error.response) return null;
  const data = error.response.data as unknown;
  if (!data || typeof data !== "object") return null;
  const code = (data as { code?: unknown }).code;
  if (typeof code !== "string") return null;
  const headers = error.response.headers as
    | { get?: (name: string) => unknown; [name: string]: unknown }
    | undefined;
  const rawType =
    typeof headers?.get === "function"
      ? headers.get("content-type")
      : headers?.["content-type"];
  const contentType = typeof rawType === "string" ? rawType : "";
  const status = (data as { status?: unknown }).status;
  return contentType.includes("application/problem+json") ||
    typeof status === "number"
    ? code
    : null;
}

function problemDetail(error: unknown): string | null {
  if (!isAxiosError(error)) return null;
  const detail = (error.response?.data as { detail?: unknown } | undefined)
    ?.detail;
  if (typeof detail !== "string" || !detail.trim()) return null;
  const text = detail.trim();
  return text.length > MAX_DETAIL_CHARS
    ? `${text.slice(0, MAX_DETAIL_CHARS - 1)}…`
    : text;
}

export function classifyFeedbackError(
  error: unknown,
  t: Translate,
): FeedbackFailure {
  const status = errorStatus(error);
  const code = problemCode(error);
  if (status === 401) return { kind: "unauthenticated" };
  if (status === 429) {
    const ms = retryAfterMs(error);
    return {
      kind: "rate_limited",
      waitSeconds: ms === null ? null : Math.ceil(ms / 1000),
      detail: code ? problemDetail(error) : null,
    };
  }
  if (status === 504 || code === "upstream_timeout") {
    return { kind: "outcome_unknown" };
  }
  if (code === "feedback_unavailable") return { kind: "unavailable" };
  // The platform's own 403s are problem+json (`forbidden`, `insufficient_scope`); a 403 without one is the
  // edge WAF refusing the body (typically markup or a path-like snippet).
  if (status === 403 && code === null) return { kind: "blocked" };
  return {
    kind: "other",
    message: requestErrorMessage(error, t, t("Your feedback wasn't sent.")),
  };
}

/** "about 5 minutes" / "about 2 hours" from a Retry-After in seconds. */
export function formatWait(seconds: number, t: Translate): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 60) return t("{{count}} minutes", { count: minutes });
  return t("{{count}} hours", { count: Math.ceil(minutes / 60) });
}
