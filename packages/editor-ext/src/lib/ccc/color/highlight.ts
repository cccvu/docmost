import type { Attributes } from "@tiptap/core";
import { Highlight } from "../../highlight";
import { safeCssColor } from "./safe-css-color";

/**
 * Render-gated highlight (#145): editor-ext's multicolour `Highlight` (same
 * mark name, `parseHTML`, `colorName`, commands, `Mod-Shift-h`, `==…==` rules)
 * whose `color` attribute renders `data-color` + `background-color` ONLY for a
 * value that passes `safeCssColor`. Anything else renders a plain `<mark>`.
 */
export const CccHighlight = Highlight.extend({
  addAttributes() {
    const parent: Attributes = this.parent?.() ?? {};
    return {
      ...parent,
      color: {
        ...parent.color,
        renderHTML: (attributes: Record<string, unknown>) => {
          const color = safeCssColor(attributes.color);
          if (!color) return {};
          return {
            "data-color": color,
            style: `background-color: ${color}; color: inherit`,
          };
        },
      },
    };
  },
});
