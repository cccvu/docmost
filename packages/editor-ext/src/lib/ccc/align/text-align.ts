import { TextAlign } from "@tiptap/extension-text-align";
import { TEXT_ALIGNMENTS, safeTextAlign } from "./safe-align";

/**
 * Render-gated text alignment (#145): the stock `TextAlign` extension (same name, `textAlign` attribute, `parseHTML`,
 * options and commands) whose `renderHTML` emits `text-align` ONLY for a listed alignment. Registered on both the
 * client and the server schema in place of the stock extension.
 */
export const CccTextAlign = TextAlign.extend({
  addGlobalAttributes() {
    // A configured alignment outside the four CSS keywords never renders either.
    const allowed = this.options.alignments.filter((a) =>
      (TEXT_ALIGNMENTS as readonly string[]).includes(a),
    );
    return (this.parent?.() ?? []).map((group) => ({
      ...group,
      attributes: Object.fromEntries(
        Object.entries(group.attributes).map(([name, attribute]) =>
          name !== "textAlign"
            ? [name, attribute]
            : [
                name,
                {
                  ...attribute,
                  renderHTML: (attributes: Record<string, unknown>) => {
                    const align = safeTextAlign(attributes.textAlign, allowed);
                    if (!align) return {};
                    return { style: `text-align: ${align}` };
                  },
                },
              ],
        ),
      ),
    }));
  },
});
