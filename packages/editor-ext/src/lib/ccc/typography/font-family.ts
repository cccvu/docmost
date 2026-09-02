import { getStyleProperty } from "@tiptap/core";
import { FontFamily } from "@tiptap/extension-text-style";
import {
  FONT_FAMILY_STACKS,
  FontFamilyKeyword,
  normalizeFontFamily,
} from "./scale";

/**
 * Allowlist-gated font family (issue #135), stored as a `fontFamily` keyword
 * ("serif" | "monospace") on the existing `textStyle` mark — never an arbitrary
 * family string.
 *
 * - stored value is the generic keyword (compact, controlled);
 * - `renderHTML` maps the keyword to a fixed CSS stack (HTML-portable output);
 * - `parseHTML` classifies an incoming family value back to a keyword, or null,
 *   so imports/pastes/API content round-trip to the controlled set.
 */
export const CccFontFamily = FontFamily.extend({
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          fontFamily: {
            default: null,
            parseHTML: (element) =>
              normalizeFontFamily(
                getStyleProperty(element, "font-family") ||
                  element.style.fontFamily,
              ),
            renderHTML: (attributes) => {
              const keyword = attributes.fontFamily as FontFamilyKeyword | null;
              if (keyword !== "serif" && keyword !== "monospace") return {};
              return { style: `font-family: ${FONT_FAMILY_STACKS[keyword]}` };
            },
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setFontFamily:
        (fontFamily: string) =>
        ({ chain }) => {
          const keyword = normalizeFontFamily(fontFamily);
          return chain().setMark("textStyle", { fontFamily: keyword }).run();
        },
      unsetFontFamily:
        () =>
        ({ chain }) =>
          chain()
            .setMark("textStyle", { fontFamily: null })
            .removeEmptyTextStyle()
            .run(),
    };
  },
});
