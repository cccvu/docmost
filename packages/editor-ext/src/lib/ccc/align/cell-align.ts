import { CELL_ALIGNMENTS, safeTextAlign } from "./safe-align";

/**
 * Table cell/header attributes with the inherited `align` attribute render-gated (#145): Tiptap's `align` renders
 * `text-align: ${align}` unchecked. Used by the TableCell/TableHeader seams in place of `...this.parent?.()`.
 */
export function withSafeCellAlign<T extends Record<string, any>>(
  attributes: T | undefined,
): T {
  const out = { ...(attributes ?? {}) } as Record<string, any>;
  if (out.align) {
    out.align = {
      ...out.align,
      renderHTML: (attrs: Record<string, unknown>) => {
        const align = safeTextAlign(attrs.align, CELL_ALIGNMENTS);
        if (!align) return {};
        return { style: `text-align: ${align}` };
      },
    };
  }
  return out as T;
}
