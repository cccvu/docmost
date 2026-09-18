// CCC (issue #309): load the Bases embed node view on demand. The real view pulls in the whole Bases
// grid (@tanstack/react-table + src/ee/base, ~280 KB raw) and Bases are hidden in this deployment
// (seam #70), so it must never sit on the eager graph. The fallback is an EMPTY NodeViewWrapper
// (tiptap's ReactNodeViewRenderer requires the first element to be one) and deliberately imports
// nothing from @/ee/base — that would pull the grid straight back in. The export stays NAMED
// `BaseEmbedView` so extensions.ts's `ReactNodeViewRenderer(BaseEmbedView)` is untouched.
// Chunk-load failures reload the document once (see @/features/layout/lazy-with-reload.ts).
import { Suspense } from "react";
import { lazyWithReload } from "@/features/layout/lazy-with-reload";
import { NodeViewProps, NodeViewWrapper } from "@tiptap/react";

const BaseEmbedViewImpl = lazyWithReload(() =>
  import("@/features/editor/components/base-embed/base-embed-view.tsx").then(
    (m) => ({ default: m.BaseEmbedView }),
  ),
);

export function BaseEmbedView(props: NodeViewProps) {
  return (
    <Suspense fallback={<NodeViewWrapper data-base-embed="true" />}>
      <BaseEmbedViewImpl {...props} />
    </Suspense>
  );
}
