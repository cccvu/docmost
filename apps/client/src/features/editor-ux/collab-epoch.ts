import { useCallback, useEffect, useRef, useState } from "react";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { COLLAB_EPOCH_PATTERN, CollabAccessState } from "./collab-access";
import type { CollabAccessController } from "./collab-access-controller";

/**
 * CCC fork addition (cccvu/wiki-v2#827) — the page's lineage epoch on the editor side.
 *
 * The server compacts a page whose Yjs history grew past its bounds: it rebuilds the document from its visible content
 * under a new epoch (`__ccc_lineage`), and refuses a copy of any other epoch (`ccc:collab-update-refused:epoch-stale:N`)
 * before it answers anything, because two lineages merged would duplicate the page's content. So the editor:
 *   - remembers each page's epoch in localStorage (every access in try/catch; an in-memory value wins over it, so a
 *     browser without storage still switches once per page view instead of looping);
 *   - keeps one IndexedDB copy per epoch: `page.<id>` at epoch 0 (every copy from before #827 stays valid), else
 *     `page.<id>.e<N>`. The Hocuspocus document name stays `page.<id>`;
 *   - claims its epoch on the socket (`?cccEpoch=N`; the server reads absent as 0);
 *   - marks a copy dirty in y-indexeddb's own store (`ccc-unsynced`) from a local edit until the server acknowledged
 *     every frame (the provider's unsynced count reached 0). A clean copy switches to the new epoch with a toast, and
 *     its old databases are deleted best-effort; a dirty (or unreadable) one keeps the old copy read-only and shows the
 *     Discard-first "compacted" notice, because its unsaved changes cannot merge into the new lineage.
 *
 * Residual: a crash between y-indexeddb storing an edit and the marker write can leave a dirty copy marked clean.
 * Wired by page-editor.tsx (seam 169) and collab-access-controller.ts.
 */

export const COLLAB_EPOCH_STORAGE_PREFIX = "ccc:collab-epoch:";
/** The socket URL's query parameter (the server: absent = epoch 0). */
export const COLLAB_EPOCH_QUERY = "cccEpoch";
/** The y-indexeddb custom-store key: 1 while this copy holds a change the server has not acknowledged. */
export const COLLAB_UNSYNCED_KEY = "ccc-unsynced";

/** Epochs this page view switched to: they win over storage, which may be unwritable. */
const switchedEpochs = new Map<string, number>();

function defaultStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** This page's epoch: the one this view switched to, else the stored one, else 0. Never throws. */
export function readCollabEpoch(
  pageId: string,
  storage: Pick<Storage, "getItem"> | null = defaultStorage(),
): number {
  const switched = switchedEpochs.get(pageId);
  if (switched !== undefined) return switched;
  try {
    const stored = storage?.getItem(COLLAB_EPOCH_STORAGE_PREFIX + pageId);
    return typeof stored === "string" && COLLAB_EPOCH_PATTERN.test(stored)
      ? Number(stored)
      : 0;
  } catch {
    return 0;
  }
}

/** Remember this page's epoch, in memory for this view and in storage when it can be written. Never throws. */
export function writeCollabEpoch(
  pageId: string,
  epoch: number,
  storage: Pick<Storage, "setItem" | "removeItem"> | null = defaultStorage(),
): void {
  switchedEpochs.set(pageId, epoch);
  try {
    if (epoch === 0) storage?.removeItem(COLLAB_EPOCH_STORAGE_PREFIX + pageId);
    else storage?.setItem(COLLAB_EPOCH_STORAGE_PREFIX + pageId, String(epoch));
  } catch {
    // best-effort: the in-memory value covers this view
  }
}

/** The IndexedDB name of this page's local copy at `epoch` (epoch 0 keeps the pre-#827 name). */
export function collabLocalCopyName(pageId: string, epoch: number): string {
  return epoch === 0 ? `page.${pageId}` : `page.${pageId}.e${epoch}`;
}

/** Whether `name` is one of this page's local copies, of any epoch. */
export function isCollabLocalCopyOf(pageId: string, name: string): boolean {
  const base = `page.${pageId}`;
  if (name === base) return true;
  return (
    name.startsWith(`${base}.e`) &&
    COLLAB_EPOCH_PATTERN.test(name.slice(base.length + 2))
  );
}

/** The collab socket URL claiming `epoch`. */
export function withCollabEpoch(url: string, epoch: number): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set(COLLAB_EPOCH_QUERY, String(epoch));
    return parsed.toString();
  } catch {
    return `${url}${url.includes("?") ? "&" : "?"}${COLLAB_EPOCH_QUERY}=${epoch}`;
  }
}

/**
 * Delete this page's local copies of every epoch but `keepEpoch`, best-effort: the names `indexedDB.databases()`
 * lists (where it exists), plus `known`. Never awaits a delete: one another tab holds open completes when it closes.
 */
export async function deleteStaleCollabCopies(
  pageId: string,
  keepEpoch: number,
  known: readonly string[] = [],
  idb: Pick<IDBFactory, "deleteDatabase"> &
    Partial<Pick<IDBFactory, "databases">> = indexedDB,
): Promise<void> {
  const keep = collabLocalCopyName(pageId, keepEpoch);
  const names = new Set(known);
  try {
    for (const { name } of (await idb.databases?.()) ?? []) {
      if (name) names.add(name);
    }
  } catch {
    // no listing: delete the known names only
  }
  for (const name of names) {
    if (name === keep || !isCollabLocalCopyOf(pageId, name)) continue;
    try {
      idb.deleteDatabase(name);
    } catch {
      // best-effort
    }
  }
}

/** The slice of `IndexeddbPersistence` the dirty marker uses. */
export interface CollabLocalCopy {
  doc: {
    on(event: "update", fn: (update: Uint8Array, origin: unknown) => void): void;
    off(event: "update", fn: (update: Uint8Array, origin: unknown) => void): void;
  };
  get(key: string): Promise<unknown>;
  set(key: string, value: number): Promise<unknown>;
}

/** The slice of `HocuspocusProvider` the dirty marker listens to. */
export interface CollabCopyProvider {
  on(event: "unsyncedChanges", fn: (e: { number?: number }) => void): unknown;
  off(event: "unsyncedChanges", fn: (e: { number?: number }) => void): unknown;
}

export interface CollabCopyTracker {
  /** Whether this copy may hold a change the server never acknowledged. An unreadable marker is dirty. */
  isDirty(): Promise<boolean>;
  destroy(): void;
}

/**
 * Keep `ccc-unsynced` current. A local edit (any update not from the local copy's own replay or from the provider)
 * marks the copy dirty; the provider's unsynced count reaching 0 (the server applied every frame it was sent, including
 * the Step2 that carries changes from before this session) marks it clean. The marker is written on each change of
 * state only, in order, and this session's own state also counts (a failed write cannot hide this session's edit).
 */
export function trackCollabCopy(
  local: CollabLocalCopy,
  provider: CollabCopyProvider,
): CollabCopyTracker {
  let dirty = false;
  let clearedThisSession = false;
  let writes: Promise<unknown> = Promise.resolve();
  const write = (value: 0 | 1) => {
    writes = writes
      .then(() => local.set(COLLAB_UNSYNCED_KEY, value))
      .catch(() => undefined);
  };
  const onUpdate = (_update: Uint8Array, origin: unknown) => {
    if (origin === local || origin === provider || dirty) return;
    dirty = true;
    write(1);
  };
  const onUnsynced = ({ number }: { number?: number } = {}) => {
    if (number !== 0 || (!dirty && clearedThisSession)) return;
    dirty = false;
    clearedThisSession = true;
    write(0);
  };
  local.doc.on("update", onUpdate);
  provider.on("unsyncedChanges", onUnsynced);
  return {
    async isDirty() {
      if (dirty) return true;
      try {
        await writes;
        return (await local.get(COLLAB_UNSYNCED_KEY)) === 1 || dirty;
      } catch {
        return true;
      }
    },
    destroy() {
      local.doc.off("update", onUpdate);
      provider.off("unsyncedChanges", onUnsynced);
    },
  };
}

export interface CollabEpochControl {
  /** The epoch this editor's copy and socket claim. */
  epoch: number;
  /** A dirty copy refused for a stale epoch: the epoch the "compacted" notice opens after Discard, else null. */
  compactedTo: number | null;
  /** After the Discard confirm cleared the old copy: switch to `compactedTo` (the editor remounts its providers). */
  openCurrentVersion(): void;
}

/**
 * The page editor's epoch. `beforeSwitch` runs in the same update as the switch (page-editor.tsx clears its
 * `providersReady`, so the editor is rebuilt on the new providers the provider effect makes for the new epoch).
 */
export function useCollabEpoch(
  pageId: string,
  access: CollabAccessState,
  controllerRef: { readonly current: Pick<CollabAccessController, "state" | "isCopyDirty"> | null },
  beforeSwitch: () => void,
): CollabEpochControl {
  const { t } = useTranslation();
  const [current, setCurrent] = useState(() => ({
    pageId,
    epoch: readCollabEpoch(pageId),
  }));
  const epoch =
    current.pageId === pageId ? current.epoch : readCollabEpoch(pageId);
  const [compactedTo, setCompactedTo] = useState<number | null>(null);
  const beforeSwitchRef = useRef(beforeSwitch);
  const epochRef = useRef(epoch);
  // Kept current after every render, before the effect below reads them (effects run in order).
  useEffect(() => {
    beforeSwitchRef.current = beforeSwitch;
    epochRef.current = epoch;
  });

  const switchTo = useCallback(
    (next: number, from: number) => {
      writeCollabEpoch(pageId, next);
      setCompactedTo(null);
      beforeSwitchRef.current();
      setCurrent({ pageId, epoch: next });
      void deleteStaleCollabCopies(pageId, next, [
        collabLocalCopyName(pageId, from),
      ]).catch(() => undefined);
    },
    [pageId],
  );

  // Once per refusal: keyed on the refusal's epoch alone (a switch changes `epoch`, not this, so it never re-runs it).
  useEffect(() => {
    // Read the controller, not the render's state: after a page change its state may still be the old page's.
    const controller = controllerRef.current;
    const to = controller?.state.epochChangedTo ?? null;
    if (!controller || to === null || to === epochRef.current) return;
    let live = true;
    controller.isCopyDirty().then(
      (dirty) => {
        if (!live) return;
        if (dirty) {
          setCompactedTo(to);
          return;
        }
        switchTo(to, epochRef.current);
        notifications.show({
          message: t(
            "This page was optimized on the server. You are now editing its current version.",
          ),
        });
      },
      () => live && setCompactedTo(to),
    );
    return () => {
      live = false;
    };
  }, [access.epochChangedTo, controllerRef, switchTo]);

  const openCurrentVersion = useCallback(() => {
    if (compactedTo !== null) switchTo(compactedTo, epoch);
  }, [compactedTo, epoch, switchTo]);

  return { epoch, compactedTo, openCurrentVersion };
}
