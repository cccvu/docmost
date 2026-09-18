// CCC (issue #309): load the KaTeX inline view (katex + katex.min.css, ~241 KB raw) on demand.
// Mirrors upstream's excalidraw-view-lazy.tsx, except the fallback is NOT null: an empty inline
// node view would collapse the node and shift the surrounding line while the chunk loads, so we
// render the raw LaTeX source inside a NodeViewWrapper span carrying the same class the real view
// uses (tiptap's ReactNodeViewRenderer also requires the first element to be a NodeViewWrapper).
import { lazy, Suspense } from "react";
import { NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import classes from "@/features/editor/components/math/math.module.css";

const MathInlineView = lazy(
  () => import("@/features/editor/components/math/math-inline.tsx"),
);

function MathInlineFallback({ node }: NodeViewProps) {
  return (
    <NodeViewWrapper as="span" data-katex="true" className={classes.mathInline}>
      {node.attrs.text}
    </NodeViewWrapper>
  );
}

export default function MathInlineViewLazy(props: NodeViewProps) {
  return (
    <Suspense fallback={<MathInlineFallback {...props} />}>
      <MathInlineView {...props} />
    </Suspense>
  );
}
