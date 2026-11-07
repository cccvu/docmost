import { RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * CCC editor-UX (issue #135): ARIA roving-tabindex for the `role="toolbar"`.
 *
 * Without this, a keyboard user tabs through ~18 controls before reaching the
 * page. The APG toolbar pattern makes the toolbar a SINGLE tab stop and moves
 * focus between controls with the arrow keys:
 *   - Tab / Shift-Tab  → in/out of the toolbar as one stop;
 *   - ← / →            → previous / next control;
 *   - Home / End       → first / last control;
 *   - Escape           → leave the toolbar (back to the editor via `onExit`);
 *   - Alt+F10 (global) → jump INTO the toolbar (to its current stop).
 *
 * Deliberately small and self-contained: it only manages the toolbar's own
 * focusable controls and never fires while focus is inside a portaled menu
 * dropdown (that focus is outside the toolbar root), so Mantine's own menu
 * keyboard handling is untouched.
 *
 * #145: the effect keys on the toolbar ELEMENT, not the (stable) ref object,
 * because the caller may render null until its editor exists (FixedToolbar on
 * an Edit-default page load); and a MutationObserver re-assigns the tab stop
 * when controls are disabled/enabled or added/removed, so the toolbar always
 * has exactly one tab stop (a re-enabled Undo never becomes a second one, and a
 * disabled active control never leaves it with none).
 */

const FOCUSABLE = "button:not([disabled]), a[href], input:not([disabled])";
const DISABLED = "button[disabled], input[disabled]";

export function useRovingToolbar(
  ref: RefObject<HTMLElement | null>,
  onExit?: () => void,
): void {
  // Hold onExit in a ref updated each render so the effect below does NOT list
  // it as a dependency. Callers pass a fresh arrow (`() => editor.commands.focus()`)
  // every render; if that were a dep, the effect would tear down + re-register
  // all listeners and reset the roving tab stop to the first control on every
  // toolbar re-render (frequent during editing) — losing the user's position.
  // (Latest-ref pattern: written in an effect, never during render.)
  const onExitRef = useRef(onExit);
  useEffect(() => {
    onExitRef.current = onExit;
  });

  // The element the ref currently points at, synced after every commit so the
  // effect below runs when the toolbar mounts (or is replaced), not only once.
  const [root, setRoot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (ref.current !== root) setRoot(ref.current);
  });

  useEffect(() => {
    if (!root) return;

    const items = (): HTMLElement[] =>
      Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getAttribute("aria-hidden") !== "true" && !!el.offsetParent,
      );

    const setTabStops = (active?: HTMLElement) => {
      const list = items();
      if (list.length === 0) return;
      const chosen = active && list.includes(active) ? active : list[0];
      list.forEach((el) => {
        el.tabIndex = el === chosen ? 0 : -1;
      });
      // A disabled control keeps -1 so it is not a second stop once re-enabled.
      root.querySelectorAll<HTMLElement>(DISABLED).forEach((el) => {
        el.tabIndex = -1;
      });
    };

    setTabStops();

    // Writes only tabIndex, which is not observed, so it cannot loop.
    const observer = new MutationObserver(() =>
      setTabStops(
        root.querySelector<HTMLElement>('[tabindex="0"]:not([disabled])') ??
          undefined,
      ),
    );
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["disabled"],
    });

    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      if (items().includes(target)) setTabStops(target);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onExitRef.current?.();
        return;
      }
      const list = items();
      const idx = list.indexOf(document.activeElement as HTMLElement);
      if (idx === -1) return; // focus is inside an open menu, not on a control
      let next = -1;
      switch (e.key) {
        case "ArrowRight":
          next = (idx + 1) % list.length;
          break;
        case "ArrowLeft":
          next = (idx - 1 + list.length) % list.length;
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = list.length - 1;
          break;
        default:
          return;
      }
      e.preventDefault();
      const target = list[next];
      if (!target) return;
      target.focus();
      // focus() scrolls only as far as the control's border box and ignores the
      // scroll container's `scroll-padding-inline`, so a control landing just
      // inside the edge (e.g. at 375px) kept its 2px+2px focus ring clipped.
      // scrollIntoView honours scroll-padding. Guarded: jsdom lacks it.
      target.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    };

    const onGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && e.key === "F10") {
        // APG toolbar pattern: return to the current roving stop (the control
        // with tabIndex 0), falling back to the first enabled control.
        const list = items();
        const target = list.find((el) => el.tabIndex === 0) ?? list[0];
        if (target) {
          e.preventDefault();
          target.focus();
        }
      }
    };

    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("keydown", onKeyDown);
    document.addEventListener("keydown", onGlobalKeyDown);
    return () => {
      observer.disconnect();
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keydown", onGlobalKeyDown);
    };
  }, [root]);
}
