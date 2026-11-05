import * as JSZip from 'jszip';
import { Readable } from 'node:stream';
import { Logger } from '@nestjs/common';
import { ExportService } from '../../integrations/export/export.service';
import { ExportStorageException, ExportTooLargeException } from './export-limits';
import { MISSING_ATTACHMENTS_FILE } from './export-attachment-plan';

/**
 * #699 — the upstream `ExportService` seam, driven through its real `exportPages` / `exportSpace` / `zipPages` /
 * `zipAttachments` / `resolveAccessibleAttachments` with stubbed repos, storage and query builder. Fork-owned; lives
 * here (not under integrations/) so the CI fork lane runs it.
 *
 * The load-bearing property: the attachment budget is computed ONLY over attachments the caller may see. An attachment
 * a visible page embeds but whose owner page is hidden is never planned, so it adds nothing to the budget, is never
 * HEADed and never read: 422-vs-200 tells the caller nothing about content it cannot view.
 */

// loadExportContent is exercised against Postgres in export-content.pg.spec.ts; here it is a spy that sets content
// from a fixture, so the seam's ordering (select without content → filter → load) is what is pinned.
const CONTENT: Record<string, unknown> = {};
const loadSpy = jest.fn(async (_db: unknown, pages: Array<{ id: string; content?: unknown }>) => {
  for (const p of pages) p.content = CONTENT[p.id] ?? null;
  return pages;
});
// ESM-only; used solely to slug page-mention links, which these fixtures do not have.
jest.mock('@sindresorhus/slugify', () => ({ __esModule: true, default: (s: string) => s.toLowerCase() }));
jest.mock('./index', () => ({ ...jest.requireActual('./index'), loadExportContent: (...a: [unknown, any[]]) => loadSpy(...a) }));

const WS = 'ws-1';
const A = '00000000-0000-4000-8000-00000000000a'; // attachment ids are uuids (getAttachmentIds ignores anything else)
const H = '00000000-0000-4000-8000-00000000000b';
const SPACE = 'space-1';

const doc = (...attachmentIds: string[]) => ({
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'body' }] },
    ...attachmentIds.map((id) => ({
      type: 'image',
      attrs: { src: `/api/files/${id}/${id}.png`, attachmentId: id },
    })),
  ],
});

const pageRow = (id: string, parentPageId: string | null, title: string, content?: unknown) => ({
  id,
  slugId: `slug-${id}`,
  title,
  icon: null,
  position: 'a0',
  parentPageId,
  spaceId: SPACE,
  workspaceId: WS,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  ...(content === undefined ? {} : { content }),
});

/** A minimal stand-in for the Kysely chains ExportService builds: rows by table, every select recorded. */
function fakeDb(tables: Record<string, unknown[]>) {
  const selects: Record<string, unknown[]> = {};
  const db = {
    selectFrom(table: string) {
      const chain: any = {
        select(x: unknown) {
          (selects[table] ??= []).push(x);
          return chain;
        },
        where: () => chain,
        $if: () => chain,
        execute: async () => tables[table] ?? [],
        executeTakeFirst: async () => (tables[table] ?? [])[0],
      };
      return chain;
    },
  };
  return { db, selects };
}

function storageStub(objects: Record<string, string>, opts: { existsError?: Error } = {}) {
  return {
    exists: jest.fn(async (p: string) => {
      if (opts.existsError) throw opts.existsError;
      return p in objects;
    }),
    readStream: jest.fn(async (p: string) => Readable.from([Buffer.from(objects[p])])),
    read: jest.fn(async () => {
      throw new Error('#699: the export must never read an attachment whole');
    }),
  };
}

async function unzip(stream: Readable): Promise<JSZip> {
  const parts: Buffer[] = [];
  for await (const c of stream) parts.push(c as Buffer);
  return JSZip.loadAsync(Buffer.concat(parts));
}

function service(opts: {
  pages: ReturnType<typeof pageRow>[];
  attachments: Array<{ id: string; fileName: string; filePath: string; fileSize: number | null; pageId: string }>;
  visible: string[];
  storage: ReturnType<typeof storageStub>;
}) {
  const { db, selects } = fakeDb({
    workspaces: [{ hostname: 'wiki' }],
    attachments: opts.attachments,
    spaces: [{ id: SPACE, name: 'Space' }],
    pages: opts.pages,
  });
  const visible = new Set(opts.visible);
  const pageRepo = {
    findById: jest.fn(async (id: string) => {
      const p = opts.pages.find((x) => x.id === id);
      return p ? { ...p, content: CONTENT[id] } : undefined;
    }),
    getPageAndDescendants: jest.fn(async (_id: string, o: { includeContent: boolean }) =>
      opts.pages.map((p) => (o.includeContent ? { ...p, content: CONTENT[p.id] } : { ...p })),
    ),
  };
  const pagePermissionRepo = {
    filterAccessiblePageIds: jest.fn(async ({ pageIds }: { pageIds: string[] }) => pageIds.filter((id) => visible.has(id))),
  };
  const svc = new ExportService(
    pageRepo as any,
    pagePermissionRepo as any,
    db as any,
    opts.storage as any,
    {} as any,
    { getUrl: () => 'https://wiki.test' } as any,
  );
  return { svc, pageRepo, pagePermissionRepo, selects };
}

describe('ExportService #699 seam', () => {
  const env = process.env.EXPORT_ATTACHMENTS_MAX_BYTES;
  let warn: jest.SpyInstance;
  beforeEach(() => {
    loadSpy.mockClear();
    for (const k of Object.keys(CONTENT)) delete CONTENT[k];
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (env === undefined) delete process.env.EXPORT_ATTACHMENTS_MAX_BYTES;
    else process.env.EXPORT_ATTACHMENTS_MAX_BYTES = env;
  });

  // Root (visible) embeds A (owner: Root, visible) and H (owner: Secret, hidden from the caller).
  const fixture = (budget: number) => {
    process.env.EXPORT_ATTACHMENTS_MAX_BYTES = String(budget);
    CONTENT.root = doc(A, H);
    CONTENT.child = doc(A);
    return {
      pages: [pageRow('root', null, 'Root'), pageRow('child', 'root', 'Child')],
      attachments: [
        { id: A, fileName: 'a.png', filePath: 'ws/a/a.png', fileSize: 60, pageId: 'root' },
        { id: H, fileName: 'h.png', filePath: 'ws/h/h.png', fileSize: 60, pageId: 'secret' },
      ],
      visible: ['root', 'child'],
    };
  };

  it('a hidden owner page’s attachment adds 0 bytes: it is never planned, HEADed or read', async () => {
    // A once under Root's folder and once under Child's: 2 × 60 = 120 ≤ 120. With H counted it would be 180.
    const f = fixture(120);
    const storage = storageStub({ 'ws/a/a.png': 'AAAA', 'ws/h/h.png': 'SECRET' });
    const { svc } = service({ ...f, storage });

    const result = await svc.exportPages('root', 'markdown', true, true, 'user-1');
    expect(result.type).toBe('zip');
    expect(storage.exists.mock.calls.map(([p]) => p)).toEqual(['ws/a/a.png']);
    const zip = await unzip((result as { stream: Readable }).stream);
    const names = Object.keys(zip.files);
    expect(names.some((n) => n.includes(H))).toBe(false);
    expect(await zip.file(`/files/${A}/a.png`)!.async('string')).toBe('AAAA');
    expect(storage.readStream.mock.calls.map(([p]) => p)).toEqual(['ws/a/a.png', 'ws/a/a.png']);
    expect(storage.read).not.toHaveBeenCalled();
  });

  it('the budget still refuses (422, before any storage call) when the VISIBLE attachments are over it', async () => {
    const f = fixture(119);
    const storage = storageStub({ 'ws/a/a.png': 'AAAA' });
    const { svc } = service({ ...f, storage });
    const err = await svc.exportPages('root', 'markdown', true, true, 'user-1').catch((e) => e);
    expect(err).toBeInstanceOf(ExportTooLargeException);
    expect(storage.exists).not.toHaveBeenCalled();
  });

  it('a missing object is left out and listed in missing-attachments.txt; the export still succeeds', async () => {
    const f = fixture(1000);
    const storage = storageStub({}); // att-a is gone from storage
    const { svc } = service({ ...f, storage });
    const result = await svc.exportPages('root', 'markdown', true, false, 'user-1');
    const zip = await unzip((result as { stream: Readable }).stream);
    expect(zip.file(`/files/${A}/a.png`)).toBeNull();
    expect(await zip.file(MISSING_ATTACHMENTS_FILE)!.async('string')).toContain(`/files/${A}/a.png\tRoot`);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^EXPORT_ATTACHMENT_MISSING export=page:root page=root attachment=${A}`)));
  });

  it('any other storage error answers 503 before any byte (the export is never silently incomplete)', async () => {
    const f = fixture(1000);
    const storage = storageStub({ 'ws/a/a.png': 'AAAA' }, { existsError: Object.assign(new Error('timeout'), { name: 'TimeoutError' }) });
    const { svc } = service({ ...f, storage });
    await expect(svc.exportPages('root', 'markdown', true, false, 'user-1')).rejects.toBeInstanceOf(ExportStorageException);
  });

  it('a subtree export selects pages WITHOUT content and loads content only for the pages that passed the filter', async () => {
    const f = fixture(1000);
    const storage = storageStub({ 'ws/a/a.png': 'AAAA' });
    const { svc, pageRepo } = service({ ...f, visible: ['root'], storage });
    await svc.exportPages('root', 'html', false, true, 'user-1');
    expect(pageRepo.getPageAndDescendants).toHaveBeenCalledWith('root', { includeContent: false });
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(loadSpy.mock.calls[0][1].map((p) => p.id)).toEqual(['root']); // the hidden child's content is never loaded
  });

  it('a space export selects no content up front and loads it only for the filtered set', async () => {
    const f = fixture(1000);
    const storage = storageStub({ 'ws/a/a.png': 'AAAA' });
    const { svc, selects } = service({ ...f, visible: ['root'], storage });
    const out = await svc.exportSpace(SPACE, 'markdown', true, 'user-1');
    expect(JSON.stringify(selects.pages)).not.toContain('content');
    expect(loadSpy.mock.calls[0][1].map((p) => p.id)).toEqual(['root']);
    const zip = await unzip(out.fileStream as Readable);
    expect(await zip.file(`/files/${A}/a.png`)!.async('string')).toBe('AAAA');
  });

  it('the /v1 single-page export (no children, no attachments) is unchanged: a plain file, no zip, no content bound', async () => {
    const f = fixture(1000);
    const storage = storageStub({});
    const { svc } = service({ ...f, storage });
    const result = await svc.exportPages('root', 'html', false, false, 'user-1');
    expect(result.type).toBe('file');
    expect(loadSpy).not.toHaveBeenCalled();
    expect(storage.exists).not.toHaveBeenCalled();
  });
});
