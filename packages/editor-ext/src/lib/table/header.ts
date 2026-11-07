import { TableHeader as TiptapTableHeader } from "@tiptap/extension-table";
import { safeCssColor } from "../ccc/color/safe-css-color"; // CCC #145
import { withSafeCellAlign } from "../ccc/align/cell-align"; // CCC #145

export const TableHeader = TiptapTableHeader.extend({
  name: "tableHeader",
  content:
    "(paragraph | heading | bulletList | orderedList | taskList | blockquote | callout | image | video | audio | subpages | attachment | mathBlock | details | codeBlock)+",

  addAttributes() {
    return {
      ...withSafeCellAlign(this.parent?.()), // CCC #145: render-gated `align`
      backgroundColor: {
        default: null,
        parseHTML: (element) =>
          element.style.backgroundColor ||
          element.getAttribute("data-background-color") ||
          null,
        renderHTML: (attributes) => {
          const backgroundColor = safeCssColor(attributes.backgroundColor); // CCC #145: render gate
          if (!backgroundColor) {
            return {};
          }
          return {
            style: `background-color: ${backgroundColor}`,
            "data-background-color": backgroundColor,
          };
        },
      },
      backgroundColorName: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute("data-background-color-name") || null,
        renderHTML: (attributes) => {
          if (!attributes.backgroundColorName) {
            return {};
          }
          return {
            "data-background-color-name":
              attributes.backgroundColorName.toLowerCase(),
          };
        },
      },
    };
  },
});
