import { useCallback, useRef, useState } from "react";

/**
 * CCC (issue: UI polish) — shared fork-owned hook.
 *
 * Reports whether a single-line, ellipsis-truncated element is ACTUALLY overflowing
 * (`scrollWidth > clientWidth`), measured on demand (mouse enter / focus). This is the same
 * idiom the upstream `AutoTooltipText` uses, extracted so a consumer can wrap its own native
 * element (e.g. the sidebar page-tree title `<span>`) and reveal a hover tooltip only when
 * the text is truncated — never a redundant tooltip on a title that already fits.
 *
 * It lives under `features/layout/` (a fork-owned, boundary-excluded dir) alongside the other
 * shared shell/UI primitives, so it stays out of the upstream boundary and is unit-testable.
 */
export function useIsTruncated<T extends HTMLElement = HTMLElement>() {
  const ref = useRef<T>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  const measure = useCallback(() => {
    const el = ref.current;
    if (el) {
      setIsTruncated(el.scrollWidth > el.clientWidth);
    }
  }, []);

  return { ref, isTruncated, measure };
}
