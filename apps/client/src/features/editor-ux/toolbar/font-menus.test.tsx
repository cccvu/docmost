// #145: the font size / font family menus expose the active value as a radio group (menuitemradio +
// aria-checked), name the trigger with the value ("Font size: Large", "Font size: Mixed"), show "Mixed"
// visibly, and keep menu-button semantics (aria-haspopup / aria-expanded) on the BUTTON despite the Tooltip
// between Menu.Target and it. Rendered for real: a minimal Tiptap editor (the mainExtensions barrel throws
// under jsdom) inside a MantineProvider.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { TextStyle } from "@tiptap/extension-text-style";
import { CccFontFamily, CccFontSize } from "@docmost/editor-ext";
import { FontSizeGroup } from "./font-size-group";
import { FontFamilyGroup } from "./font-family-group";
import { collectTextStyleAttr } from "./selection-attr";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Mantine's Menu (Popover) needs matchMedia + ResizeObserver in jsdom.
beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
  if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

let editor: Editor | undefined;
afterEach(() => {
  cleanup();
  editor?.destroy();
  editor = undefined;
});

function mount(group: "size" | "family", content = "<p>hello world</p>") {
  editor = new Editor({
    extensions: [StarterKit, TextStyle, CccFontSize, CccFontFamily],
    content,
  });
  const Group = group === "size" ? FontSizeGroup : FontFamilyGroup;
  render(
    // env="test": no transitions or portals, so the dropdown is in the tree as soon as it opens.
    <MantineProvider env="test">
      <Group editor={editor as never} />
    </MantineProvider>,
  );
  return editor;
}

const trigger = (name: RegExp) => screen.getByRole("button", { name });

async function openMenu(name: RegExp) {
  fireEvent.click(trigger(name));
  return screen.findByRole("menu");
}

const checkedItems = () =>
  screen
    .getAllByRole("menuitemradio")
    .filter((el) => el.getAttribute("aria-checked") === "true")
    .map((el) => el.textContent);

describe("FontSizeGroup", () => {
  it("is a menu button whose name carries the current value (Normal by default)", async () => {
    mount("size");
    const button = trigger(/^Font size: Normal$/);
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.getAttribute("aria-expanded")).toBe("false");

    await openMenu(/^Font size/);
    expect(trigger(/^Font size/).getAttribute("aria-expanded")).toBe("true");
  });

  it("exposes the options as a radio group with the active value checked", async () => {
    const e = mount("size");
    act(() => {
      e.chain().selectAll().setFontSize("18px").run();
    });
    expect(trigger(/^Font size: Large$/)).toBeTruthy();

    await openMenu(/^Font size/);
    const items = screen.getAllByRole("menuitemradio");
    expect(items.map((el) => el.textContent)).toEqual([
      "Small",
      "Normal",
      "Large",
      "Extra large",
    ]);
    expect(checkedItems()).toEqual(["Large"]);
  });

  it("checks Normal when no size is set", async () => {
    mount("size");
    await openMenu(/^Font size/);
    expect(checkedItems()).toEqual(["Normal"]);
  });

  it("shows and announces a Mixed state for a selection spanning several sizes", async () => {
    const e = mount("size");
    act(() => {
      // "hello" = [1,6), "world" = [7,12)
      e.chain().setTextSelection({ from: 1, to: 6 }).setFontSize("18px").run();
      e.chain().setTextSelection({ from: 7, to: 12 }).setFontSize("20px").run();
      e.chain().selectAll().run();
    });
    expect(trigger(/^Font size: Mixed$/)).toBeTruthy();

    const menu = await openMenu(/^Font size/);
    expect(checkedItems()).toEqual([]);
    expect(menu.textContent).toContain("Font size: Mixed");
  });

  it("labels the dropdown by its visible header, not by the Tooltip-held target id", async () => {
    mount("size");
    await openMenu(/^Font size/);
    expect(
      screen.getByRole("menu", { name: "Font size: Normal" }),
    ).toBeTruthy();
  });

  it("applies the chosen size, closes the menu, and Normal unsets it", async () => {
    const e = mount("size");
    act(() => {
      e.chain().selectAll().run();
    });

    await openMenu(/^Font size/);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Large" }));
    expect(collectTextStyleAttr(e as never, "fontSize")).toBe("18px");
    await waitFor(() =>
      expect(trigger(/^Font size: Large$/).getAttribute("aria-expanded")).toBe(
        "false",
      ),
    );

    act(() => {
      e.chain().selectAll().run();
    });
    await openMenu(/^Font size/);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Normal" }));
    expect(collectTextStyleAttr(e as never, "fontSize")).toBeNull();
  });
});

describe("FontFamilyGroup", () => {
  it("names the trigger with the value and checks the active family", async () => {
    const e = mount("family");
    expect(trigger(/^Font: Default$/).getAttribute("aria-haspopup")).toBe(
      "menu",
    );
    act(() => {
      e.chain().selectAll().setFontFamily("serif").run();
    });
    expect(trigger(/^Font: Serif$/)).toBeTruthy();

    await openMenu(/^Font:/);
    expect(checkedItems()).toEqual(["Serif"]);
  });

  it("shows Mixed for a selection spanning several families", () => {
    const e = mount("family");
    act(() => {
      e.chain()
        .setTextSelection({ from: 1, to: 6 })
        .setFontFamily("serif")
        .run();
      e.chain().selectAll().run();
    });
    expect(trigger(/^Font: Mixed$/)).toBeTruthy();
  });
});
