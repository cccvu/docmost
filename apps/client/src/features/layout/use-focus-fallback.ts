// wiki-v2 #913 — NOT upstream Docmost code.
import { useCallback, useEffect, useRef } from "react";
import { MAIN_CONTENT_ID } from "@/components/ui/skip-to-main.tsx";
import { restoreFocus } from "./focus-fallback";

/** How long an armed fallback waits for the removal. A removal slower than this leaves focus where it fell. */
export const FOCUS_FALLBACK_ARM_MS = 15_000;

/**
 * How long a check that finds focus still inside a closing dialog waits for it to leave. Mantine's exit
 * transition is about 200 ms; a dialog that is still focused after this is not closing, so focus is left alone.
 */
export const FOCUS_FALLBACK_DIALOG_WAIT_MS = 3_000;

/** The tab that labels the tab panel `el` sits in (`role="tabpanel"` + `aria-labelledby`), or null. */
export function enclosingTab(el: Element | null | undefined): HTMLElement | null {
  const id = el?.closest('[role="tabpanel"]')?.getAttribute("aria-labelledby");
  return id ? document.getElementById(id) : null;
}

/** Focus is on a connected element inside a dialog (a confirm modal that may still be in its exit transition). */
function focusHeldByDialog(): boolean {
  const active = document.activeElement;
  return (
    !!active &&
    active !== document.body &&
    active.isConnected &&
    !!active.closest('[role="dialog"]')
  );
}

/**
 * Calls `done` once focus is no longer held inside a dialog (it was lost, or it landed elsewhere), checked on
 * every DOM change. Gives up after {@link FOCUS_FALLBACK_DIALOG_WAIT_MS}. Plain DOM, no React state: it keeps
 * running after the component that started it unmounted; the timer bounds it. `onEnd` runs when it stops.
 */
function waitForDialogToRelease(done: () => void, onEnd: () => void): void {
  const observer = new MutationObserver(() => {
    if (focusHeldByDialog()) return;
    stop();
    done();
  });
  const timer = window.setTimeout(() => stop(), FOCUS_FALLBACK_DIALOG_WAIT_MS);
  const stop = () => {
    observer.disconnect();
    window.clearTimeout(timer);
    onEnd();
  };
  observer.observe(document.body, { childList: true, subtree: true });
}

/**
 * For a confirmed action that removes the element that held focus (a confirm modal's Delete or Restore whose
 * row, tree node or banner then disappears). Mantine's modal returns focus to its trigger on close, but the
 * trigger is removed only later, once the mutation and the refetch commit, and focus then falls to <body>.
 *
 * Returns `arm`: call it when the user confirms. While armed, after every commit of the calling component and
 * when it unmounts, {@link restoreFocus} runs with the main content (`MAIN_CONTENT_ID`, the skip link's
 * target, `tabIndex={-1}`). It acts only when focus is already lost, so a trigger that survives (the action
 * failed, or the user moved on) keeps focus. Disarms once it moved focus, or {@link FOCUS_FALLBACK_ARM_MS}
 * after `arm`.
 *
 * The dialog race: a check can run while focus is still inside the closing confirm dialog (Mantine returns
 * focus about 10 ms after close, often to an already-detached menu item, and the dialog content unmounts only
 * after its exit transition). The check then waits, on DOM changes, until focus leaves the dialog, and restores
 * it if it was lost (see `waitForDialogToRelease`). The wait outlives the component, so a row that removed
 * itself is still covered.
 *
 * Call the hook in the component that owns the trigger (or its list): a row that unmounts covers itself through
 * the unmount, and a list that re-renders without the row covers it through the commit.
 *
 * `getTarget` (optional, #858) names a more specific target, tried before the main content: for a removal
 * outside it, such as a comment in the aside (its tab). It is read when focus is restored, so capture the
 * target before the removal (an unmounting row's own refs are already gone by then).
 */
export function useFocusFallback(
  getTarget?: () => HTMLElement | null | undefined,
): () => void {
  const armedUntil = useRef(0);
  const waiting = useRef(false);
  const target = useRef(getTarget);
  // Declared before the settle effects, so they (and the unmount) read the latest getter.
  useEffect(() => {
    target.current = getTarget;
  });

  const settle = useCallback(function settleFocus(): void {
    if (!armedUntil.current) return;
    if (Date.now() > armedUntil.current) {
      armedUntil.current = 0;
      return;
    }
    // A wait already re-checks on every DOM change, including the commit that removes the trigger.
    if (waiting.current) return;
    if (focusHeldByDialog()) {
      waiting.current = true;
      waitForDialogToRelease(settleFocus, () => {
        waiting.current = false;
      });
      return;
    }
    if (
      restoreFocus(
        target.current?.(),
        document.getElementById(MAIN_CONTENT_ID),
      )
    ) {
      armedUntil.current = 0;
    }
  }, []);

  // No dependency list on purpose: every commit of the caller may be the one that removed the trigger.
  useEffect(settle);
  // The unmount check. It may start a dialog wait, which is deliberately not cancelled here.
  useEffect(() => settle, [settle]);

  return useCallback(() => {
    armedUntil.current = Date.now() + FOCUS_FALLBACK_ARM_MS;
  }, []);
}
