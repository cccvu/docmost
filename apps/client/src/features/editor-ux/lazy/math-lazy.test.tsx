import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { NodeViewProps } from "@tiptap/react";
import MathBlockViewLazy from "./math-block-lazy";
import MathInlineViewLazy from "./math-inline-lazy";

// Each heavy view module (katex + its CSS) resolves only when the test says so, so we can
// observe the fallback while the chunk is "in flight" and then watch the real view replace it.
const deferred = vi.hoisted(() => {
  const make = () => {
    let resolve!: (mod: unknown) => void;
    const promise = new Promise<unknown>((r) => (resolve = r));
    return { promise, resolve };
  };
  return { block: make(), inline: make() };
});

vi.mock(
  "@/features/editor/components/math/math-block.tsx",
  () => deferred.block.promise,
);
vi.mock(
  "@/features/editor/components/math/math-inline.tsx",
  () => deferred.inline.promise,
);

function nodeViewProps(text: string): NodeViewProps {
  return {
    node: { attrs: { text }, nodeSize: 1 },
    editor: { isEditable: true, state: { selection: {} }, commands: {} },
    getPos: () => 0,
    updateAttributes: vi.fn(),
    deleteNode: vi.fn(),
    selected: false,
  } as unknown as NodeViewProps;
}

describe("math lazy node views (issue #309)", () => {
  it("block: shows the raw source in a NodeViewWrapper div while the katex chunk is pending", () => {
    const { container } = render(<MathBlockViewLazy {...nodeViewProps("E = mc^2")} />);
    const wrapper = container.querySelector('[data-katex="true"]');
    expect(wrapper).toBeTruthy();
    expect(wrapper!.tagName).toBe("DIV");
    // tiptap's ReactNodeViewRenderer throws unless the first element is a NodeViewWrapper.
    expect(wrapper!.hasAttribute("data-node-view-wrapper")).toBe(true);
    expect(screen.getByText("E = mc^2")).toBeTruthy();
  });

  it("inline: shows the raw source in a NodeViewWrapper span while the katex chunk is pending", () => {
    const { container } = render(<MathInlineViewLazy {...nodeViewProps("a^2 + b^2")} />);
    const wrapper = container.querySelector('[data-katex="true"]');
    expect(wrapper).toBeTruthy();
    expect(wrapper!.tagName).toBe("SPAN");
    expect(wrapper!.hasAttribute("data-node-view-wrapper")).toBe(true);
    expect(screen.getByText("a^2 + b^2")).toBeTruthy();
  });

  it("block: the real view replaces the fallback once the chunk resolves", async () => {
    render(<MathBlockViewLazy {...nodeViewProps("\\int_0^1 x")} />);
    expect(screen.getByText("\\int_0^1 x")).toBeTruthy();

    deferred.block.resolve({
      default: (props: NodeViewProps) => (
        <div data-testid="real-block">rendered:{props.node.attrs.text}</div>
      ),
    });

    const real = await screen.findByTestId("real-block");
    expect(real.textContent).toBe("rendered:\\int_0^1 x");
    expect(screen.queryByText("\\int_0^1 x")).toBeNull();
  });

  it("inline: the real view replaces the fallback once the chunk resolves", async () => {
    render(<MathInlineViewLazy {...nodeViewProps("\\alpha")} />);
    expect(screen.getByText("\\alpha")).toBeTruthy();

    deferred.inline.resolve({
      default: (props: NodeViewProps) => (
        <span data-testid="real-inline">rendered:{props.node.attrs.text}</span>
      ),
    });

    const real = await screen.findByTestId("real-inline");
    expect(real.textContent).toBe("rendered:\\alpha");
    expect(screen.queryByText("\\alpha")).toBeNull();
  });
});
