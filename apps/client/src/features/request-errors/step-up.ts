import { isAxiosError } from "axios";
import APP_ROUTE, { isPublicRoutePath, safeRedirectPath } from "@/lib/app-route.ts";

// wiki-v2 #713 — NOT upstream Docmost code. In remote mode the engine answers a sensitive action (a permanent delete,
// a page-restriction write, a space settings update) with `403 {code: "step_up_required"}` when the
// wiki session's sign-in is not recent. The fix is the platform's: its console `/console/confirm` page re-proves the
// human, re-mints the wiki session (fresh) and sends the browser back here, where the user repeats the action. It is a
// 403 and never a 401 on purpose: on a 401 the api client silently re-mints the session, which would come back just
// as stale.

export const STEP_UP_REQUIRED_CODE = "step_up_required";
export const STEP_UP_CONFIRM_PATH = "/console/confirm";

// An error body carried as a Blob (a `responseType: "blob"` request) is read only when it is a small JSON document;
// anything else is not the engine's step-up answer. No gated route is blob-typed today (exports are reads, never
// stepped up); this keeps the redirect working if one becomes so.
const MAX_BLOB_ERROR_BYTES = 4096;

type Loc = Pick<Location, "pathname" | "search">;

// `Blob.text()` where the runtime has it, else a FileReader (older DOM implementations lack the former).
function blobText(blob: Blob): Promise<string> {
  if (typeof blob.text === "function") return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

async function errorCode(data: unknown): Promise<string | undefined> {
  let body: unknown = data;
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    if (body.size > MAX_BLOB_ERROR_BYTES || !/json/i.test(body.type)) return undefined;
    try {
      body = JSON.parse(await blobText(body));
    } catch {
      return undefined;
    }
  }
  const code =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as { code?: unknown }).code
      : undefined;
  return typeof code === "string" ? code : undefined;
}

/** The request's path, from the final response URL when the transport exposes it, else from the axios config. */
function requestPath(error: { request?: unknown; config?: { baseURL?: string; url?: string } }): string | undefined {
  const responseURL = (error.request as { responseURL?: unknown } | undefined)?.responseURL;
  try {
    if (typeof responseURL === "string" && responseURL) return new URL(responseURL).pathname;
  } catch {
    // fall back to the config below
  }
  const base = error.config?.baseURL ?? "";
  const url = error.config?.url ?? "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return undefined; // an absolute URL is not this app's api
  return `${base.replace(/\/+$/, "")}/${url.replace(/^\/+/, "")}`;
}

/** The console confirm page that returns the browser to `loc` (or to home, when `loc` is not a safe same-origin path). */
export function stepUpConfirmHref(loc: Loc): string {
  const back = safeRedirectPath(loc.pathname + loc.search) ?? APP_ROUTE.HOME;
  return `${STEP_UP_CONFIRM_PATH}?return=${encodeURIComponent(back)}`;
}

/**
 * Where to send the browser for an `/api` error that asks for a recent sign-in, or `null` when this error is not
 * that, or when the page is a public or shared one (an anonymous reader has nothing to confirm). Never throws; the
 * caller still rejects the error, so the action's own error handling runs as before.
 */
export async function stepUpRedirectFor(error: unknown, loc: Loc): Promise<string | null> {
  if (!isAxiosError(error) || error.response?.status !== 403) return null;
  if (loc.pathname.startsWith("/share/") || isPublicRoutePath(loc.pathname)) return null;
  const path = requestPath(error);
  if (!path || !path.startsWith("/api/")) return null;
  if ((await errorCode(error.response.data)) !== STEP_UP_REQUIRED_CODE) return null;
  return stepUpConfirmHref(loc);
}
