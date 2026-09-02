import { RefObject, useEffect } from "react";

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
 *   - Alt+F10 (global) → jump INTO the toolbar from the editor.
 *
 * Deliberately small and self-contained: it only manages the toolbar's own
 * focusable controls and never fires while focus is inside a portaled menu
 * dropdown (that focus is outside the toolbar root), so Mantine's own menu
 * keyboard handling is untouched.
 */

const FOCUSABLE = "button:not([disabled]), a[href], input:not([disabled])";

export function useRovingToolbar(
  ref: RefObject<HTMLElement | null>,
  onExit?: () => void,
): void {
  useEffect(() => {
    const root = ref.current;
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
    };

    setTabStops();

    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      if (items().includes(target)) setTabStops(target);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onExit?.();
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
      list[next]?.focus();
    };

    const onGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && e.key === "F10") {
        const first = items()[0];
        if (first) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("keydown", onKeyDown);
    document.addEventListener("keydown", onGlobalKeyDown);
    return () => {
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keydown", onGlobalKeyDown);
    };
  }, [ref, onExit]);
}
