// CCC (fork-owned, wiki-v2 #858) — NOT upstream Docmost code.
//
// The server refuses a publish (share create or update) with `403 {code: 'share_not_permitted'}` when the
// caller may edit the page but their role may not publish it (`SharePublishGate`, ADR 0032 amendment, #704).
// The client has no proactive signal for that, so the Publish tab learns it from the refusal: it then keeps
// the switch off, disables it and shows this reason for the rest of the modal session. UX only; the server
// decides.

/** Same text as the server's `SHARE_NOT_PERMITTED_MESSAGE`, used only if a refusal arrives without one. */
const FALLBACK = "Your role does not allow publishing pages to the web";

/** The server's reason when `err` is a `share_not_permitted` refusal; otherwise null. */
export function sharePublishRefusal(err: unknown): string | null {
  const data = (
    err as { response?: { data?: { code?: unknown; message?: unknown } } }
  )?.response?.data;
  if (data?.code !== "share_not_permitted") return null;
  return typeof data.message === "string" && data.message !== ""
    ? data.message
    : FALLBACK;
}
