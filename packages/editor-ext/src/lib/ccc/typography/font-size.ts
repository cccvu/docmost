import { getStyleProperty } from "@tiptap/core";
import { FontSize } from "@tiptap/extension-text-style";
import { ALLOWED_FONT_SIZES, normalizeFontSize } from "./scale";

/**
 * Allowlist-gated font size (issue #135), stored as a `fontSize` attribute on
 * the existing `textStyle` mark.
 *
 * - `parseHTML` snaps any incoming size (HTML import, paste) to the controlled
 *   scale, or drops it to null.
 * - `renderHTML` emits `style:font-size` ONLY for an exact allowed value, so a
 *   hostile or arbitrary value arriving through the JSON API / MCP (which
 *   bypasses `parseHTML`) never reaches the DOM as inline CSS. This is the
 *   render-path security gate the plain upstream extension lacks.
 */
export const CccFontSize = FontSize.extend({
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element) =>
              normalizeFontSize(
                getStyleProperty(element, "font-size") ||
                  element.style.fontSize,
              ),
            renderHTML: (attributes) => {
              const value =
                typeof attributes.fontSize === "string"
                  ? attributes.fontSize.trim().toLowerCase()
                  : null;
              if (!value || !ALLOWED_FONT_SIZES.includes(value)) return {};
              return { style: `font-size: ${value}` };
            },
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setFontSize:
        (fontSize: string) =>
        ({ chain }) => {
          const normalized = normalizeFontSize(fontSize);
          if (!normalized) {
            return chain()
              .setMark("textStyle", { fontSize: null })
              .removeEmptyTextStyle()
              .run();
          }
          return chain().setMark("textStyle", { fontSize: normalized }).run();
        },
      unsetFontSize:
        () =>
        ({ chain }) =>
          chain()
            .setMark("textStyle", { fontSize: null })
            .removeEmptyTextStyle()
            .run(),
    };
  },
});
