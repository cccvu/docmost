import { StarterKit } from '@tiptap/starter-kit';
import { TextAlign } from '@tiptap/extension-text-align';
import { Superscript } from '@tiptap/extension-superscript';
import SubScript from '@tiptap/extension-subscript';
import { Typography } from '@tiptap/extension-typography';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import { Youtube } from '@tiptap/extension-youtube';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import {
  Heading,
  Callout,
  Comment,
  CustomCodeBlock,
  Details,
  DetailsContent,
  DetailsSummary,
  LinkExtension,
  MathBlock,
  MathInline,
  TableHeader,
  TableCell,
  TableRow,
  CustomTable,
  TiptapImage,
  TiptapVideo,
  TiptapAudio,
  TiptapPdf,
  PageBreak,
  TrailingNode,
  Attachment,
  Drawio,
  Excalidraw,
  Embed,
  Mention,
  Subpages,
  Highlight,
  Indent,
  UniqueID,
  Columns,
  Column,
  Status,
  addUniqueIdsToDoc,
  htmlToMarkdown,
  TransclusionSource,
  TransclusionReference,
  BaseEmbed,
  CccFontSize,
  CccFontFamily,
} from '@docmost/editor-ext';
import { generateText, getSchema, JSONContent } from '@tiptap/core';
import { generateHTML, generateJSON } from '../common/helpers/prosemirror/html';
// @tiptap/html library works best for generating prosemirror json state but not HTML
// see: https://github.com/ueberdosis/tiptap/issues/5352
// see:https://github.com/ueberdosis/tiptap/issues/4089
//import { generateJSON } from '@tiptap/html';
import { Node, Schema } from '@tiptap/pm/model';
import * as Y from 'yjs';
import { Logger } from '@nestjs/common';
import { validate as isValidUUID } from 'uuid';
// Leaf helper (no imports of its own) → safe to import here; `prosemirror/utils.ts` imports FROM this
// file, so importing `isAttachmentNode` from there instead would be circular. (#392)
import { isAttachmentNode } from '../common/helpers/prosemirror/attachment-node-types';

export const tiptapExtensions = [
  StarterKit.configure({
    codeBlock: false,
    link: false,
    trailingNode: false,
    heading: false,
  }),
  Heading,
  UniqueID.configure({
    types: ['heading', 'paragraph', 'transclusionSource'],
  }),
  Comment,
  TextAlign.configure({ types: ['heading', 'paragraph'] }),
  Indent,
  TaskList,
  TaskItem.configure({
    nested: true,
  }),
  LinkExtension,
  Superscript,
  SubScript,
  Highlight,
  Typography,
  TrailingNode,
  TextStyle,
  Color,
  // CCC controlled typography (issue #135) — attrs on the `textStyle` mark.
  // MUST stay registered in lockstep with the client schema (extensions.ts),
  // else these schema-bound paths (jsonToNode / rehydration / duplicate /
  // share / html) would silently strip fontSize/fontFamily.
  CccFontSize,
  CccFontFamily,
  MathInline,
  MathBlock,
  Details,
  DetailsContent,
  DetailsSummary,
  CustomTable,
  TableCell,
  TableRow,
  TableHeader,
  Youtube,
  TiptapImage,
  TiptapVideo,
  TiptapAudio,
  TiptapPdf,
  PageBreak,
  Callout,
  Attachment,
  CustomCodeBlock,
  Drawio,
  Excalidraw,
  Embed,
  Mention,
  Subpages,
  Columns,
  Column,
  Status,
  TransclusionSource,
  TransclusionReference,
  BaseEmbed
] as any;

export function jsonToHtml(tiptapJson: any) {
  return generateHTML(tiptapJson, tiptapExtensions);
}

// #392: a same-origin attachment file URL is uniform across every attachment node type —
// `/api/files/<uuid>/<name>` or `/files/<uuid>/<name>`, optionally `/api/files/public/<uuid>/...`
// (share) and optionally a `?t=`/`?jwt=` query. Anchored to a LEADING SLASH so an external
// `https://evil.example/api/files/<uuid>/x` can never match. The `{36}` group is a loose extractor;
// `isValidUUID` (the same version-agnostic validator `getAttachmentIds` uses — Docmost mints uuidv7,
// so a v4-only regex would silently no-op) is the precise gate.
const ATTACHMENT_FILE_URL_ID = /^\/(?:api\/)?files\/(?:public\/)?([0-9a-f-]{36})(?:[/?#]|$)/i;

function attachmentIdFromFileUrl(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  const match = ATTACHMENT_FILE_URL_ID.exec(url);
  if (!match) return undefined;
  return isValidUUID(match[1]) ? match[1] : undefined;
}

/**
 * #392: back-fill `attachmentId` from a node's file URL when it is missing.
 *
 * Every attachment node type (`image`/`video`/`audio`/`pdf`/`attachment`/`excalidraw`/`drawio`)
 * parses `attachmentId` ONLY from a `data-attachment-id` HTML attribute, so an agent authoring the
 * natural `<img src="/api/files/<uuid>/x.png">` (or `<video src>`/`<audio src>`) over the `/v1` API
 * gets `attachmentId: null` — the image renders (the view uses `src` alone) but the page↔attachment
 * linkage is lost, orphaning the file to `getAttachmentIds` (export / share / duplicate all key on it).
 * The URL lives in `attrs.src` for every type except `attachment`, which uses `attrs.url`; both are
 * handled. An EXPLICIT `data-attachment-id` always wins (we only fill an absent one). Runs after
 * `generateJSON` (the server HTML→JSON + markdown-import path); mutates `pmJson` in place.
 */
function backfillAttachmentIds(node: any): void {
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

export function htmlToJson(html: string) {
  const pmJson = generateJSON(html, tiptapExtensions);

  // #392: rebuild attachment linkage before anything downstream reads it. Mutates in place so the
  // fill survives even if `addUniqueIdsToDoc` throws and we fall back to `pmJson`.
  backfillAttachmentIds(pmJson);

  try {
    return addUniqueIdsToDoc(pmJson, tiptapExtensions);
  } catch (error) {
    console.warn('failed to add unique ids to doc', error);
    return pmJson;
  }
}

export function jsonToText(tiptapJson: JSONContent) {
  return generateText(tiptapJson, tiptapExtensions);
}

export function jsonToNode(tiptapJson: JSONContent) {
  const schema = getSchema(tiptapExtensions);
  try {
    return Node.fromJSON(schema, tiptapJson);
  } catch (error) {
    if (
      error instanceof RangeError &&
      error.message.includes('Unknown node type')
    ) {
      Logger.warn('Stripping unknown node types from document:', error.message);
      const cleanedJson = stripUnknownNodes(tiptapJson, schema);
      return Node.fromJSON(schema, cleanedJson);
    }
    throw error;
  }
}

export function getPageId(documentName: string) {
  return documentName.split('.')[1];
}

export function isEmptyParagraphDoc(tiptapJson: JSONContent): boolean {
  if (!tiptapJson || tiptapJson.type !== 'doc') return false;
  const content = tiptapJson.content;
  if (!Array.isArray(content) || content.length !== 1) return false;
  const child = content[0];
  if (!child || child.type !== 'paragraph') return false;
  return (
    !child.content ||
    (Array.isArray(child.content) && child.content.length === 0)
  );
}

function stripUnknownNodes(
  json: JSONContent,
  schema: Schema,
): JSONContent | null {
  if (!json || typeof json !== 'object') return json;

  // Recursively clean children first, flattening any unwrapped content
  if (json.content && Array.isArray(json.content)) {
    const newContent: JSONContent[] = [];
    for (const child of json.content) {
      const cleaned = stripUnknownNodes(child, schema);
      if (Array.isArray(cleaned)) {
        newContent.push(...cleaned);
      } else if (cleaned) {
        newContent.push(cleaned);
      }
    }
    json.content = newContent;
  }

  // Check if this node is unknown AFTER processing children
  if (json.type && !schema.nodes[json.type]) {
    // Unwrap: return cleaned children directly instead of wrapping
    return (
      json.content && json.content.length > 0 ? json.content : null
    ) as any;
  }

  return json;
}

export function prosemirrorNodeToYElement(node: any): Y.XmlElement | Y.XmlText {
  if (node.type === 'text') {
    const ytext = new Y.XmlText();
    ytext.insert(0, node.text || '');
    if (node.marks?.length > 0) {
      const attrs: Record<string, any> = {};
      for (const mark of node.marks) {
        attrs[mark.type] = mark.attrs || true;
      }
      ytext.format(0, node.text?.length || 0, attrs);
    }
    return ytext;
  }

  const element = new Y.XmlElement(node.type);
  if (node.attrs) {
    for (const [key, value] of Object.entries(node.attrs)) {
      if (value !== null && value !== undefined) {
        element.setAttribute(key, value as any);
      }
    }
  }
  if (node.content?.length > 0) {
    const children = node.content.map(prosemirrorNodeToYElement);
    element.insert(0, children);
  }
  return element;
}

export function jsonToMarkdown(tiptapJson: any): string {
  const html = jsonToHtml(tiptapJson);
  return htmlToMarkdown(html);
}
