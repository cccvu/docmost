// CCC (issue #309): load the KaTeX block view (katex + katex.min.css, ~241 KB raw) on demand.
// Mirrors upstream's excalidraw-view-lazy.tsx, except the fallback is NOT null: an empty node view
// would collapse the block and shift layout while the chunk loads, so we render the raw LaTeX
// source inside the same NodeViewWrapper/class the real view uses (tiptap's ReactNodeViewRenderer
// also requires the first element to be a NodeViewWrapper).
// Chunk-load failures reload the document once (see @/features/layout/lazy-with-reload.ts).
import { Suspense } from "react";
import { lazyWithReload } from "@/features/layout/lazy-with-reload";
import { NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import classes from "@/features/editor/components/math/math.module.css";

const MathBlockView = lazyWithReload(
  () => import("@/features/editor/components/math/math-block.tsx"),
);

function MathBlockFallback({ node }: NodeViewProps) {
  return (
    <NodeViewWrapper data-katex="true" className={classes.mathBlock}>
      <div>{node.attrs.text}</div>
    </NodeViewWrapper>
  );
}

export default function MathBlockViewLazy(props: NodeViewProps) {
  return (
    <Suspense fallback={<MathBlockFallback {...props} />}>
      <MathBlockView {...props} />
    </Suspense>
  );
}
