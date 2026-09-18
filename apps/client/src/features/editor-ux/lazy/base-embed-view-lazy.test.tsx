import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { NodeViewProps } from "@tiptap/react";
import { BaseEmbedView } from "./base-embed-view-lazy";

// The real embed view drags in the whole Bases grid (@tanstack/react-table + src/ee/base); it resolves
// only when the test says so, so we can observe the fallback and then the swap.
const deferred = vi.hoisted(() => {
  let resolve!: (mod: unknown) => void;
  const promise = new Promise<unknown>((r) => (resolve = r));
  return { promise, resolve };
});
vi.mock(
  "@/features/editor/components/base-embed/base-embed-view.tsx",
  () => deferred.promise,
);

const props = {
  node: { attrs: { baseId: "b-1" }, nodeSize: 1 },
  editor: { isEditable: true, state: { selection: {} }, commands: {} },
  getPos: () => 0,
  updateAttributes: vi.fn(),
  deleteNode: vi.fn(),
  selected: false,
} as unknown as NodeViewProps;

describe("BaseEmbedView lazy node view (issue #309)", () => {
  it("keeps the identifier a plain component so ReactNodeViewRenderer(BaseEmbedView) works", () => {
    expect(typeof BaseEmbedView).toBe("function");
    expect((BaseEmbedView as { $$typeof?: symbol }).$$typeof).toBeUndefined();
  });

  it("renders an empty NodeViewWrapper while the Bases chunk is pending, then the real view", async () => {
    const { container } = render(<BaseEmbedView {...props} />);
    const wrapper = container.querySelector('[data-base-embed="true"]');
    expect(wrapper).toBeTruthy();
    expect(wrapper!.tagName).toBe("DIV");
    // tiptap's ReactNodeViewRenderer throws unless the first element is a NodeViewWrapper.
    expect(wrapper!.hasAttribute("data-node-view-wrapper")).toBe(true);
    expect(wrapper!.childElementCount).toBe(0);

    deferred.resolve({
      BaseEmbedView: (p: NodeViewProps) => (
        <div data-testid="real-embed">embed:{p.node.attrs.baseId}</div>
      ),
    });

    const real = await screen.findByTestId("real-embed");
    expect(real.textContent).toBe("embed:b-1");
    expect(container.querySelector('[data-base-embed="true"]')).toBeNull();
  });
});
