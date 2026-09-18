/**
 * Attachment-id backfill on the HTML→JSON write path (issue #392).
 *
 * Every attachment node type parses `attachmentId` ONLY from a `data-attachment-id` attribute, so an
 * agent authoring the natural `<img src="/api/files/<uuid>/x.png">` (or `<video src>`/`<audio src>`)
 * over the `/v1` API produced a node with `attachmentId: null` — it rendered (the view reads `src`
 * alone) but the page↔attachment linkage was lost, orphaning the file to `getAttachmentIds` (which
 * export / share / duplicate all key on). `htmlToJson` now back-fills `attachmentId` from the node's
 * same-origin file URL (`attrs.src`, or `attrs.url` for the `attachment` node). These specs pin the
 * real conversion path: the natural-HTML footgun types (Class A: image/video/audio), the URL variants,
 * that an explicit id still wins, that external URLs and the inline-`data:` gate are unaffected, and
 * that the non-standard-wrapper types (Class B) are covered as a safety net.
 *
 * Run in CI via the `docmost-authz` job's jest glob (`src/authz src/service-bridge src/editor-compat`).
 */
import { htmlToJson } from '../collaboration/collaboration.util';

// Valid UUIDs (v7-shaped: version nibble 7, variant 8) — `validate` from `uuid` accepts versions 1–8.
const UUID_A = '0192f1a0-1b2c-7d3e-8f4a-5b6c7d8e9f00';
const UUID_B = '0192f1a0-1b2c-7d3e-8f4a-5b6c7d8e9f11';

const findFirst = (json: any, type: string): any => {
  if (!json || typeof json !== 'object') return undefined;
  if (json.type === type) return json;
  if (Array.isArray(json.content)) {
    for (const c of json.content) {
      const f = findFirst(c, type);
      if (f) return f;
    }
  }
  return undefined;
};

const attachmentIdOf = (html: string, type: string): unknown =>
  findFirst(htmlToJson(html), type)?.attrs?.attachmentId;

describe('#392 htmlToJson back-fills attachmentId from a same-origin file URL', () => {
  describe('Class A — natural HTML tags (the real footgun)', () => {
    it('image: <img src="/api/files/<uuid>/…"> recovers the id', () => {
      expect(attachmentIdOf(`<img src="/api/files/${UUID_A}/pic.png">`, 'image')).toBe(UUID_A);
    });

    it('video: <video src="/api/files/<uuid>/…"> recovers the id', () => {
      expect(attachmentIdOf(`<video src="/api/files/${UUID_A}/clip.mp4"></video>`, 'video')).toBe(UUID_A);
    });

    it('audio: <audio src="/api/files/<uuid>/…"> recovers the id', () => {
      expect(attachmentIdOf(`<audio src="/api/files/${UUID_A}/song.mp3"></audio>`, 'audio')).toBe(UUID_A);
    });
  });

  describe('URL variants', () => {
    it('accepts the /files/<uuid> form (no /api prefix)', () => {
      expect(attachmentIdOf(`<img src="/files/${UUID_A}/pic.png">`, 'image')).toBe(UUID_A);
    });

    it('accepts the /api/files/public/<uuid> (share) form', () => {
      expect(attachmentIdOf(`<img src="/api/files/public/${UUID_A}/pic.png">`, 'image')).toBe(UUID_A);
    });

    it('strips a query string (?t=/?jwt=)', () => {
      expect(attachmentIdOf(`<img src="/api/files/${UUID_A}/pic.png?t=abc123">`, 'image')).toBe(UUID_A);
    });
  });

  describe('an explicit data-attachment-id always wins', () => {
    it('keeps data-attachment-id even when the src carries a different id', () => {
      expect(
        attachmentIdOf(`<img src="/api/files/${UUID_A}/pic.png" data-attachment-id="${UUID_B}">`, 'image'),
      ).toBe(UUID_B);
    });
  });

  describe('does NOT back-fill from an untrusted or non-attachment URL', () => {
    it('leaves an external URL untouched', () => {
      expect(attachmentIdOf('<img src="https://example.com/pic.png">', 'image') ?? null).toBeNull();
    });

    it('rejects an external URL that merely contains /api/files/<uuid> (anchored to a leading slash)', () => {
      expect(
        attachmentIdOf(`<img src="https://evil.example/api/files/${UUID_A}/pic.png">`, 'image') ?? null,
      ).toBeNull();
    });

    it('rejects a non-UUID first segment', () => {
      expect(attachmentIdOf('<img src="/api/files/not-a-valid-uuid-000000000000/x.png">', 'image') ?? null).toBeNull();
    });
  });

  describe('the inline-data: image gate is unaffected', () => {
    it('still drops a data: image entirely (no image node)', () => {
      const json = htmlToJson('<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA=">');
      expect(findFirst(json, 'image')).toBeUndefined();
    });
  });

  describe('Class B — non-standard wrappers (safety net)', () => {
    it('attachment node: back-fills from data-attachment-url (attrs.url)', () => {
      const html = `<div data-type="attachment" data-attachment-url="/api/files/${UUID_A}/report.pdf" data-attachment-name="report.pdf" data-attachment-mime="application/pdf"></div>`;
      expect(attachmentIdOf(html, 'attachment')).toBe(UUID_A);
    });
  });
});
