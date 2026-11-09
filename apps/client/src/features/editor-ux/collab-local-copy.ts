/**
 * CCC fork addition (cccvu/wiki-v2#781) — the "Discard this browser's copy" action of the refusal notice
 * (`collab-refusal-notice.tsx`). Wired by page-editor.tsx (seam 169).
 *
 * Clear this page's local Yjs copy and resolve only once the database is gone. `clearData()` starts the delete
 * without waiting for it, and the delete waits behind any other tab that holds the database open; a reload in
 * that state hangs the new page's own open behind it. So confirm with a second delete (queued after the first,
 * so its success means both completed), and treat `blocked` as a failure the user can fix by closing those tabs.
 */
export async function clearLocalCollabCopy(
  local: { name: string; clearData(): Promise<void> } | undefined,
  idb: Pick<IDBFactory, "deleteDatabase"> = indexedDB,
): Promise<void> {
  if (!local) throw new Error("no local copy");
  await local.clearData();
  await new Promise<void>((resolve, reject) => {
    const request = idb.deleteDatabase(local.name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error("delete failed"));
    request.onblocked = () => reject(new Error("delete blocked"));
  });
}
