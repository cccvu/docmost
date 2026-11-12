/**
 * CCC fork addition (cccvu/wiki-v2#781 lineage, the ledger-echo incident) — what the page header's connection status
 * (`yjsConnectionStatusAtom`) reads once the server refused this editor.
 *
 * The header's ConnectionWarning shows "Real-time editor connection lost. Retrying..." 5 s after the atom reads
 * `disconnected` or `connecting`. After a refusal nothing retries (the provider is detached and the socket closed for
 * good, `collab-access.ts`), and the refusal notice says what happened, so the header must not. Two writers would
 * otherwise say it anyway:
 *   - a raw socket close (a 1009, or the server's own `ws.close(4422, reason)` once a socket's refusals run out): the
 *     socket marks itself disconnected and the still-attached provider forwards that status to page-editor BEFORE the
 *     controller sees the close and detaches;
 *   - page-editor's 7.5 s check ("still connecting, or not synced → disconnected"): a refusal that lands before the
 *     first sync (the IndexedDB echo is sent on connect, ahead of it) leaves the editor unsynced for good.
 * (A document CLOSE after the first sync needs neither: @hocuspocus/provider 4.7.1 emits `synced` only when it becomes
 * true, and the detach comes before the socket's own disconnect, so the header keeps reading `connected`.)
 *
 * #842: an `unresolved` retry's wait (up to 8 s) is not a refusal: the socket is closed and does retry, so "Retrying..."
 * is true there. Only once its budget is spent is it a refusal, and quiet like any other.
 *
 * page-editor.tsx (seam 169) passes every status it would set through `collabHeaderStatus`, and a small effect applies
 * it whenever the refusal or the status changes. `""` is the atom's initial value, which ConnectionWarning ignores.
 */
export const COLLAB_HEADER_QUIET = "";

export function collabHeaderStatus(status: string, refused: boolean): string {
  return refused ? COLLAB_HEADER_QUIET : status;
}
