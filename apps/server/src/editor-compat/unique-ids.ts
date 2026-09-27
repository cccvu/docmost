import type { Extensions, JSONContent } from '@tiptap/core';
import { getSchema } from '@tiptap/core';
import { Fragment, Node } from '@tiptap/pm/model';

/**
 * #626 — the same result as `addUniqueIdsToDoc` (packages/editor-ext), in one linear pass.
 *
 * Fork-owned (boundary-excluded), wired into `htmlToJson` at the `collaboration.util.ts` seam (UPSTREAM_MODIFICATIONS
 * #61), like `backfillAttachmentIds`.
 *
 * Upstream applies one `tr.setNodeAttribute` per node that needs an id. Every step copies the child array of each
 * ancestor on the node's path, and the transaction keeps every intermediate document, so a parent with n children
 * that need ids costs O(n²) time AND memory: 20k sibling paragraphs (160 KB of `<p>x</p>`) took ~12 s, and a
 * 180 KB table row exhausted a 4 GB heap. This rebuilds the tree once instead, copying only the nodes whose subtree
 * changed.
 *
 * Kept identical to upstream: the UniqueID extension's `types`, `attributeName` and `generateID` are read the same
 * way; the schema is built with that extension last (as upstream does, so attribute order and defaults match); only
 * nodes BELOW the doc are considered (`findChildren` semantics); a node that already has an id keeps it; and
 * `generateID({ node, pos })` is called in document order with the original node and its position.
 */
export function addUniqueIds(doc: JSONContent, extensions: Extensions): JSONContent {
  const uniqueIDExtension = extensions.find((ext) => ext.name === 'uniqueID');
  if (!uniqueIDExtension) {
    throw new Error('UniqueID extension not found in the extensions array');
  }
  const { types, attributeName, generateID } = uniqueIDExtension.options as {
    types: string[];
    attributeName: string;
    generateID: (ctx: { node: Node; pos: number }) => unknown;
  };

  const schema = getSchema([...extensions.filter((ext) => ext.name !== 'uniqueID'), uniqueIDExtension]);
  const contentNode = Node.fromJSON(schema, doc);

  /** The node's children with ids added, or null when none changed. `start` is the first child's position. */
  const mapChildren = (node: Node, start: number): Fragment | null => {
    let changed = null as Node[] | null;
    node.forEach((child, offset, index) => {
      const next = withIds(child, start + offset);
      if (next !== child && !changed) changed = node.content.content.slice(0, index);
      if (changed) changed.push(next);
    });
    return changed && Fragment.fromArray(changed);
  };

  // `pos` is the node's position in the document, as `descendants` reports it. The id is generated before the
  // children are visited, so `generateID` sees nodes in the same order as upstream's `findChildren`.
  const withIds = (node: Node, pos: number): Node => {
    const id = !node.attrs[attributeName] && types.includes(node.type.name) ? generateID({ node, pos }) : undefined;
    const content = mapChildren(node, pos + 1);
    if (id === undefined) return content ? node.copy(content) : node;
    return node.type.create({ ...node.attrs, [attributeName]: id }, content ?? node.content, node.marks);
  };

  // The doc itself is never given an id; its children start at position 0.
  const content = mapChildren(contentNode, 0);
  return (content ? contentNode.copy(content) : contentNode).toJSON();
}
