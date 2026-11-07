import { Color } from "@tiptap/extension-text-style";
import { safeCssColor } from "./safe-css-color";

/**
 * Render-gated text colour (#145): the stock `Color` extension (same name,
 * `textStyle` attribute, `parseHTML`, `setColor`/`unsetColor` commands) whose
 * `renderHTML` emits `style: color` ONLY for a value that passes
 * `safeCssColor`. A hostile value stored through the JSON API / MCP / Yjs stays
 * in the document but never reaches the DOM or an HTML export as CSS — the same
 * gate `CccFontSize` applies to `fontSize`.
 */
export const CccColor = Color.extend({
  addGlobalAttributes() {
    return (this.parent?.() ?? []).map((group) => ({
      ...group,
      attributes: Object.fromEntries(
        Object.entries(group.attributes).map(([name, attribute]) =>
          name !== "color"
            ? [name, attribute]
            : [
                name,
                {
                  ...attribute,
                  renderHTML: (attributes: Record<string, unknown>) => {
                    const color = safeCssColor(attributes.color);
                    if (!color) return {};
                    return { style: `color: ${color}` };
                  },
                },
              ],
        ),
      ),
    }));
  },
});
