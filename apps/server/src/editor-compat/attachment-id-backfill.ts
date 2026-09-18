import { validate as isValidUUID } from 'uuid';
import { isAttachmentNode } from '../common/helpers/prosemirror/attachment-node-types';

/**
 * #392 — recover a node's `attachmentId` from its same-origin file URL when HTML authoring omitted it.
 *
 * Fork-owned (boundary-excluded) logic per the repo's fork model: genuinely-new logic lives here, and
 * the upstream `collaboration.util.ts` seam only imports + calls `backfillAttachmentIds` (mirrors how the
 * CCC typography schema lives in `packages/editor-ext/src/lib/ccc` and `collaboration.util.ts` merely
 * registers it — see UPSTREAM_MODIFICATIONS.md #61).
 *
 * Every attachment node type (`image`/`video`/`audio`/`pdf`/`attachment`/`excalidraw`/`drawio`) parses
 * `attachmentId` ONLY from a `data-attachment-id` attribute, so an agent authoring the natural
 * `<img src="/api/files/<uuid>/x.png">` (or `<video src>`/`<audio src>`) over the /v1 API produced a node
 * with `attachmentId: null` — it rendered (the view reads `src` alone) but the page↔attachment linkage was
 * silently lost, orphaning the file to `getAttachmentIds` (export / share / duplicate all key on it).
 */

// A same-origin attachment file URL is uniform across every attachment node type —
// `/api/files/<uuid>/<name>` or `/files/<uuid>/<name>`, optionally `/api/files/public/<uuid>/...` (share)
// and optionally a `?t=`/`?jwt=` query. Anchored to a LEADING SLASH so an external
// `https://evil.example/api/files/<uuid>/x` can never match. The `{36}` group is a loose extractor;
// `isValidUUID` (the same version-agnostic validator `getAttachmentIds` uses — Docmost mints uuidv7, so a
// v4-only regex would silently no-op) is the precise gate.
const ATTACHMENT_FILE_URL_ID = /^\/(?:api\/)?files\/(?:public\/)?([0-9a-f-]{36})(?:[/?#]|$)/i;

function attachmentIdFromFileUrl(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  const match = ATTACHMENT_FILE_URL_ID.exec(url);
  if (!match) return undefined;
  return isValidUUID(match[1]) ? match[1] : undefined;
}

/**
 * Walk a ProseMirror JSON doc and, for any attachment node with no `attachmentId`, recover it from the
 * node's file URL (`attrs.src` for every type except the `attachment` node, which uses `attrs.url`). An
 * EXPLICIT `data-attachment-id` always wins (we only fill an absent one). Mutates `node` in place.
 */
export function backfillAttachmentIds(node: any): void {
  if (!node || typeof node !== 'object') return;
  if (
    typeof node.type === 'string' &&
    isAttachmentNode(node.type) &&
    node.attrs &&
    !node.attrs.attachmentId
  ) {
    const id = attachmentIdFromFileUrl(node.attrs.src ?? node.attrs.url);
    if (id) node.attrs.attachmentId = id;
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) backfillAttachmentIds(child);
  }
}
