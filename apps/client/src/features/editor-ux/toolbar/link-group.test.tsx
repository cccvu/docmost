// #145: Mod-K now opens the link panel on a text selection, so the toolbar Link button advertises it: the
// tooltip names the shortcut and assistive tech gets it through aria-keyshortcuts. Rendered for real with a
// minimal Tiptap editor (the mainExtensions barrel throws under jsdom) inside a MantineProvider.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { platformModifierLabel } from "@/lib/utils";
import { LinkGroup } from "./link-group";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

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

describe("LinkGroup shortcut hint (#145)", () => {
  it("exposes Mod+K via aria-keyshortcuts and names it in the tooltip", async () => {
    editor = new Editor({ extensions: [StarterKit], content: "<p>hello</p>" });
    render(
      <MantineProvider env="test">
        <LinkGroup editor={editor as never} />
      </MantineProvider>,
    );
    const button = screen.getByRole("button", { name: "Add link" });
    const ariaMod = platformModifierLabel === "⌘" ? "Meta" : "Control";
    expect(button.getAttribute("aria-keyshortcuts")).toBe(`${ariaMod}+K`);

    fireEvent.mouseEnter(button);
    expect(
      await screen.findByText(`Add link · ${platformModifierLabel}K`),
    ).toBeTruthy();
  });
});
