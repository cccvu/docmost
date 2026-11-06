/**
 * CCC #716 review: an export is requested with `responseType: "blob"`, so axios hands an error body over as a Blob,
 * not parsed JSON. `err.response.data.message` was therefore always `undefined`, and every refusal (a page too large
 * to convert, "export it as HTML", the converter budget, an engine that is busy) read "Export failed:undefined".
 *
 * This reads the engine's own JSON exception out of the Blob (or a plain object, for a non-blob caller) and returns
 * its `message`. Anything else (no response, a body that is not JSON, an oversized body) falls back to a generic line.
 */
export const EXPORT_FAILED_FALLBACK = "Please try again.";

/** An engine error body is a small JSON exception; never read a larger one into a toast. */
const MAX_ERROR_BODY_BYTES = 16 * 1024;

/** `Blob.text()` where the runtime has it; a FileReader otherwise (older engines, jsdom). */
function blobText(blob: Blob): Promise<string> {
  if (typeof blob.text === "function") return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

export async function exportErrorMessage(err: unknown): Promise<string> {
  const data = (err as { response?: { data?: unknown } } | null)?.response
    ?.data;
  try {
    let body: unknown = data;
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      if (data.size > MAX_ERROR_BODY_BYTES) return EXPORT_FAILED_FALLBACK;
      body = JSON.parse(await blobText(data));
    }
    const message =
      body && typeof body === "object"
        ? (body as { message?: unknown }).message
        : undefined;
    if (typeof message === "string" && message.trim()) return message.trim();
    if (Array.isArray(message)) {
      const parts = message.filter(
        (m): m is string => typeof m === "string" && m.trim() !== "",
      );
      if (parts.length) return parts.join("; ");
    }
  } catch {
    // not JSON, or unreadable: the generic line below
  }
  return EXPORT_FAILED_FALLBACK;
}
