import { isAxiosError } from "axios";
import { getApiErrorMessage } from "@/lib/api-error";

// #384: a rate limit used to read exactly like an outage ("Failed to fetch recent pages"). These helpers
// classify a failed request so the query layer can retry the fork's short per-principal limit once and every
// error surface can say what actually happened. Everything here reads the error defensively: a 429 can come
// from the WAF (JSON `{error, message}` + `Retry-After: 60`), the fork's limiter (Nest's `{statusCode,
// message}` + a short `Retry-After`), or a proxy in between (an HTML body, no header).

// The narrow slice of i18next's `t` these helpers call; `TFunction` and a test stub both satisfy it.
export type Translate = (
  key: string,
  options?: Record<string, unknown>,
) => string;

// A server message is shown verbatim on a 429, so bound it: it is untrusted text in a toast.
const MAX_SERVER_MESSAGE_CHARS = 200;

export function errorStatus(error: unknown): number | null {
  if (!isAxiosError(error)) return null;
  const status = error.response?.status;
  return typeof status === "number" && Number.isFinite(status) ? status : null;
}

export function isRateLimited(error: unknown): boolean {
  return errorStatus(error) === 429;
}

// Retry-After as milliseconds, or null. Only positive delta-seconds count: every emitter in front of the wiki
// sends seconds, so an HTTP-date (or anything else) is treated as absent rather than guessed at.
export function retryAfterMs(error: unknown): number | null {
  if (!isAxiosError(error) || !error.response) return null;
  const headers = error.response.headers as
    | { get?: (name: string) => unknown; [name: string]: unknown }
    | undefined;
  if (!headers) return null;
  const raw =
    typeof headers.get === "function"
      ? headers.get("retry-after")
      : headers["retry-after"];
  const text = typeof raw === "number" ? String(raw) : raw;
  if (typeof text !== "string" || !/^\d+$/.test(text.trim())) return null;
  const seconds = Number(text.trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function clampServerMessage(server: string): string {
  return server.length > MAX_SERVER_MESSAGE_CHARS
    ? `${server.slice(0, MAX_SERVER_MESSAGE_CHARS - 1)}…`
    : server;
}

function rateLimitMessage(error: unknown, t: Translate): string {
  // Only a string `message` is a human sentence (the WAF's is); an array is a validation shape, and an HTML
  // body has no `message` at all. getApiErrorMessage still does the blank-safe read.
  const message = isAxiosError(error)
    ? error.response?.data?.message
    : undefined;
  const server =
    typeof message === "string" ? getApiErrorMessage(error, "").trim() : "";
  if (server) return clampServerMessage(server);
  const ms = retryAfterMs(error);
  if (ms === null) {
    return t("Too many requests. Please wait a minute, then try again.");
  }
  return t(
    "Too many requests. Please wait about {{seconds}} seconds, then try again.",
    { seconds: Math.ceil(ms / 1000) },
  );
}

export function requestErrorMessage(
  error: unknown,
  t: Translate,
  fallback: string,
): string {
  if (isRateLimited(error)) return rateLimitMessage(error, t);
  // No response at all: offline, DNS, a dropped connection. A cancelled request is not a failure to report.
  if (isAxiosError(error) && !error.response && error.code !== "ERR_CANCELED") {
    return t("Can't reach the wiki. Check your connection and try again.");
  }
  const status = errorStatus(error);
  return status === null ? fallback : `${fallback} (HTTP ${status})`;
}

// wiki-v2 #556: a refusal the server explains — a 403 or 409 whose JSON body carries a machine `code` next to its
// sentence (the fork's fixed texts, e.g. a restore refused because it would take a page out of its restricted
// section: "nothing was restored") — is shown in the server's words, bounded. Anything else (a bare 403, a 5xx, the
// network) gets requestErrorMessage's answer, so a toast never shows an unexplained server string.
export function refusalMessage(
  error: unknown,
  t: Translate,
  fallback: string,
): string {
  const status = errorStatus(error);
  if (isAxiosError(error) && (status === 403 || status === 409)) {
    const data: unknown = error.response?.data;
    const body =
      data && typeof data === "object"
        ? (data as { code?: unknown; message?: unknown })
        : {};
    if (
      typeof body.code === "string" &&
      typeof body.message === "string" &&
      body.message.trim()
    ) {
      return clampServerMessage(body.message.trim());
    }
  }
  return requestErrorMessage(error, t, fallback);
}
