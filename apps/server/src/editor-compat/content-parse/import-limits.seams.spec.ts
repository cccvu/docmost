/**
 * #643: the per-file import bounds, through the two upstream importer seams that apply them
 * (UPSTREAM_MODIFICATIONS #147 `import.service.ts`, #176 `file-import-task.service.ts`).
 *
 * Run in CI via the `docmost-authz` job's jest glob (`… src/editor-compat …`). The conversion functions are the real
 * ones (one test runs the real worker), wrapped so a test can see whether, and how, an importer called them.
 */
import { PayloadTooLargeException } from '@nestjs/common';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import * as JSZip from 'jszip';
import { setFlagsFromString } from 'v8';
import { runInNewContext } from 'vm';

jest.mock('./content-parse.service', () => {
  const actual = jest.requireActual('./content-parse.service');
  return {
    ...actual,
    parseUntrustedContent: jest.fn((...a: unknown[]) => actual.parseUntrustedContent(...a)),
    untrustedMarkdownToHtml: jest.fn((...a: unknown[]) => actual.untrustedMarkdownToHtml(...a)),
  };
});
// The importers' cheerio entry point, observed: whether a DOM was built, and (weakly) the DOM itself. A plain function,
// not a jest.fn, whose `mock.results` would keep every DOM alive.
const doms: Array<WeakRef<object>> = [];
jest.mock('cheerio', () => {
  const actual = jest.requireActual('cheerio');
  return {
    ...actual,
    load: (...a: unknown[]) => {
      const $ = actual.load(...a);
      doms.push(new WeakRef($));
      return $;
    },
  };
});
// `import-formatter` pulls the ESM-only `@sindresorhus/slugify`, which jest does not transform; its passes are not
// under test here.
jest.mock('../../integrations/import/utils/import-formatter', () => ({
  normalizeImportHtml: () => undefined, // not a jest.fn: its recorded arguments would keep the DOM alive
  formatImportHtml: jest.fn(async ({ html }: { html: string }) => ({ html, backlinks: [], pageIcon: null })),
  unwrapFromParagraph: jest.fn(),
}));
jest.mock('../../core/page/services/page.service', () => ({ PageService: class {} }));
jest.mock('../../integrations/import/services/import-attachment.service', () => ({ ImportAttachmentService: class {} }));

import {
  closeContentParser,
  ContentTooComplexException,
  parseUntrustedContent,
  untrustedMarkdownToHtml,
} from './content-parse.service';
import { IMPORT_LIMITS, ImportTaskFailure } from './import-limits';
import { ImportService } from '../../integrations/import/services/import.service';
import { FileImportTaskService } from '../../integrations/import/services/file-import-task.service';
import { FileTaskProcessor } from '../../integrations/import/processors/file-task.processor';
import { QueueJob } from '../../integrations/queue/constants';

jest.setTimeout(180_000);
afterAll(() => closeContentParser());

const CAP = IMPORT_LIMITS.maxPageFileBytes;
const parse = parseUntrustedContent as jest.Mock;
const toHtml = untrustedMarkdownToHtml as jest.Mock;
const DOC = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] };

const actual = jest.requireActual('./content-parse.service');
beforeEach(() => {
  // mockReset also drops a once-implementation a failed test left unconsumed; then back to the real functions.
  parse.mockReset().mockImplementation((...a: unknown[]) => actual.parseUntrustedContent(...a));
  toHtml.mockReset().mockImplementation((...a: unknown[]) => actual.untrustedMarkdownToHtml(...a));
  doms.length = 0;
});

describe('#643 single-file import (seam #147)', () => {
  const pageRepo = { insertPage: jest.fn(async (p: Record<string, unknown>) => ({ ...p, id: 'page-1' })) };
  const db = {
    selectFrom: () => {
      const q: any = { select: () => q, where: () => q, orderBy: () => q, limit: () => q, executeTakeFirst: async () => undefined };
      return q;
    },
  };
  const service = new ImportService(pageRepo as any, {} as any, db as any, {} as any, {} as any);
  const upload = (filename: string, buffer: Buffer, truncated = false) =>
    Promise.resolve({ filename, file: { truncated }, toBuffer: async () => buffer } as any);
  const importPage = (file: Promise<any>) => service.importPage(file, 'user-1', 'space-1', 'ws-1');

  it.each(['big.md', 'big.html'])('%s one byte over the cap is a 413 naming the cap, before it is decoded', async (name) => {
    const buffer = Buffer.alloc(CAP + 1, 97);
    const decode = jest.spyOn(buffer, 'toString');
    const err = await importPage(upload(name, buffer)).catch((e) => e);
    expect(err).toBeInstanceOf(PayloadTooLargeException);
    expect(err.message).toBe(`File too large. '${name}' is 4.1 MB; each page file in an import is limited to 4 MB`);
    expect(decode).not.toHaveBeenCalled();
    expect(toHtml).not.toHaveBeenCalled();
    expect(doms).toHaveLength(0); // cheerio never loaded
  });

  it("fastify's 413 from toBuffer() is the 30 MB limit's own message", async () => {
    const fastify413 = Object.assign(new Error('request file too large'), { code: 'FST_REQ_FILE_TOO_LARGE', statusCode: 413 });
    const file = { filename: 'big.html', file: {}, toBuffer: () => Promise.reject(fastify413) };
    const err = await importPage(Promise.resolve(file as any)).catch((e) => e);
    expect(err).toBeInstanceOf(PayloadTooLargeException);
    expect(err.message).toBe('File too large. The import limit is 30 MB');
  });

  it('a buffer the multipart parser silently truncated is never imported', async () => {
    const err = await importPage(upload('a.html', Buffer.from('<p>cut</p>'), true)).catch((e) => e);
    expect(err).toBeInstanceOf(PayloadTooLargeException);
    expect(pageRepo.insertPage).not.toHaveBeenCalled();
  });

  it('a .md at exactly the cap is accepted, and its HTML is capped at 2× the file cap', async () => {
    toHtml.mockResolvedValueOnce('<p>hi</p>');
    parse.mockResolvedValueOnce(DOC);
    const page = await importPage(upload('ok.md', Buffer.alloc(CAP, 97)));
    expect(page).toMatchObject({ id: 'page-1' });
    expect(toHtml).toHaveBeenCalledWith(expect.any(String), undefined, { maxChars: 2 * CAP });
  });

  it('Markdown under the cap that expands past 2× the cap is refused by the real worker (422), before cheerio', async () => {
    const md = Buffer.from('a\n\n'.repeat(Math.floor((3 * 1024 * 1024) / 3))); // 3 MiB → ~9 Mi characters of HTML
    expect(md.length).toBeLessThanOrEqual(CAP);
    const err = await importPage(upload('wide.md', md)).catch((e) => e);
    expect(err).toBeInstanceOf(ContentTooComplexException);
    expect(doms).toHaveLength(0); // cheerio never loaded
  });

  it('HTML with more tags than the bound is 422 before cheerio builds a DOM', async () => {
    const html = Buffer.from('<b>'.repeat(IMPORT_LIMITS.maxHtmlTags + 1));
    expect(html.length).toBeLessThanOrEqual(CAP);
    const err = await importPage(upload('dense.html', html)).catch((e) => e);
    expect(err).toBeInstanceOf(ContentTooComplexException);
    expect(doms).toHaveLength(0); // cheerio never loaded
    expect(parse).not.toHaveBeenCalled();
  });

  it('the cheerio DOM is garbage while the import waits for the worker', async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    let release!: (doc: unknown) => void;
    parse.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const pending = service.processHTML(`<div>${'<p>x</p>'.repeat(1000)}</div>`);
    await new Promise((r) => setTimeout(r, 0)); // past the job that created the WeakRef
    gc();
    expect(doms).toHaveLength(1);
    expect(doms[0].deref()).toBeUndefined();
    release(DOC);
    await expect(pending).resolves.toBe(DOC);
  });
});

describe('#643 zip import (seam #176)', () => {
  let extractDir: string;
  beforeEach(() => {
    extractDir = mkdtempSync(join(tmpdir(), 'docmost-extract-'));
    mkdirSync(join(extractDir, 'docs'), { recursive: true });
  });
  afterEach(() => rmSync(extractDir, { recursive: true, force: true }));
  const write = (rel: string, content: string | Buffer) => writeFileSync(join(extractDir, rel), content);

  const setup = () => {
    const trx = { insertInto: () => ({ values: () => ({ execute: async () => undefined }) }) };
    const db = {
      selectFrom: jest.fn(() => {
        const q: any = { select: () => q, where: () => q, executeTakeFirst: async () => ({ slug: 's' }) };
        return q;
      }),
      transaction: jest.fn(() => ({ execute: (fn: (t: unknown) => unknown) => fn(trx) })),
    };
    const importAttachmentService = { processAttachments: jest.fn(async ({ html }: { html: string }) => html) };
    const importService = {
      processHTML: jest.fn(async () => DOC),
      extractTitleAndRemoveHeading: (s: unknown) => ({ title: null, prosemirrorJson: s }),
      createYdoc: async () => null,
    };
    const logger = { error: jest.fn(), log: jest.fn(), debug: jest.fn(), warn: jest.fn() };
    const service = new FileImportTaskService(
      {} as any, // storageService
      importService as any,
      { nextPagePosition: async () => 'a0' } as any,
      { insertBacklink: jest.fn() } as any,
      db as any,
      importAttachmentService as any,
      {} as any, // moduleRef
      { emit: jest.fn() } as any,
      { logBatchWithContext: jest.fn() } as any,
    );
    (service as any).logger = logger;
    const fileTask = { id: 'task-1', source: 'generic', spaceId: 'space-1', workspaceId: 'ws-1', creatorId: 'user-1' };
    const run = () => service.processGenericImport({ extractDir, fileTask: fileTask as any });
    return { db, importAttachmentService, importService, logger, run };
  };

  it('refuses an oversize page file by its path in the archive, before the transaction and any upload', async () => {
    write('docs/ok.md', '# ok');
    write('docs/big.html', Buffer.alloc(CAP + 1, 97));
    const { db, importAttachmentService, run } = setup();
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(PayloadTooLargeException);
    expect(err.message).toBe("'docs/big.html' is 4.1 MB; each page file in an import is limited to 4 MB");
    expect(err.message).not.toContain(extractDir);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(importAttachmentService.processAttachments).not.toHaveBeenCalled();
    expect(toHtml).not.toHaveBeenCalled();
  });

  it('imports a page file at exactly the cap, converting its Markdown with the 2× HTML cap', async () => {
    write('docs/a.md', Buffer.alloc(CAP, 97));
    toHtml.mockResolvedValueOnce('<p>a</p>');
    const { db, importAttachmentService, run } = setup();
    await run();
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(toHtml).toHaveBeenCalledWith(expect.any(String), expect.anything(), { maxChars: 2 * CAP });
    expect(importAttachmentService.processAttachments).toHaveBeenCalledTimes(1);
  });

  it('a page with more tags than the bound fails naming the page, before its first cheerio pass', async () => {
    write('docs/dense.html', '<b>'.repeat(IMPORT_LIMITS.maxHtmlTags + 1));
    const { importAttachmentService, run } = setup();
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(ImportTaskFailure);
    expect(err.message).toMatch(/^Import failed: docs\/dense\.html: The content is too large or complex/);
    expect(importAttachmentService.processAttachments).not.toHaveBeenCalled();
  });

  it('any other error fails with an authored message naming the page; the extract dir is only in the log', async () => {
    write('docs/a.html', '<p>a</p>');
    const { importAttachmentService, logger, run } = setup();
    const raw = Object.assign(new Error(`EACCES: permission denied, open '${extractDir}/docs/img.png'`), { code: 'EACCES' });
    importAttachmentService.processAttachments.mockRejectedValueOnce(raw);
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(ImportTaskFailure);
    expect(err.message).toBe('Import failed: docs/a.html: it could not be read; try again later');
    expect(err.message).not.toContain(extractDir);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('IMPORT_TASK_FAILED'), raw);
  });

  it('no stored task error carries the extract dir, whatever the failure', async () => {
    write('docs/a.md', 'x');
    const failures: unknown[] = [
      Object.assign(new Error(`ENOENT: no such file or directory, open '${extractDir}/docs/a.md'`), { code: 'ENOENT' }),
      new SyntaxError(`Unexpected token in ${extractDir}/docs-metadata.json`),
      Object.assign(new Error(`duplicate key value violates unique constraint (${extractDir})`), { code: '23505' }),
      new ContentTooComplexException(),
    ];
    for (const failure of failures) {
      const { importService, run } = setup();
      importService.processHTML.mockRejectedValueOnce(failure);
      toHtml.mockResolvedValueOnce('<p>x</p>');
      const err = await run().catch((e) => e);
      expect(err).toBeInstanceOf(ImportTaskFailure);
      expect(err.message).toMatch(/^Import failed: docs\/a\.md: /);
      expect(err.message).not.toContain(extractDir);
      expect(err.message).not.toContain(tmpdir());
    }
  });
});

describe('#643 zip import task, end to end: what the file task stores', () => {
  const TASK = { id: 'task-1', source: 'generic', status: 'processing', filePath: 'ws-1/imports/task-1/a.zip', spaceId: 'space-1', workspaceId: 'ws-1', creatorId: 'user-1' };
  const zipOf = async (files: Record<string, string | Buffer>) => {
    const zip = new JSZip();
    for (const [name, content] of Object.entries(files)) zip.file(name, content);
    return zip.generateAsync({ type: 'nodebuffer' });
  };
  const setup = (readStream: () => Promise<Readable>) => {
    const db = {
      selectFrom: () => {
        const q: any = { selectAll: () => q, select: () => q, where: () => q, executeTakeFirst: async () => TASK };
        return q;
      },
      transaction: jest.fn(),
    };
    const service = new FileImportTaskService(
      { readStream: jest.fn(readStream), delete: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      db as any,
      { processAttachments: jest.fn() } as any,
      {} as any,
      { emit: jest.fn() } as any,
      {} as any,
    );
    (service as any).logger = { error: jest.fn(), log: jest.fn(), debug: jest.fn(), warn: jest.fn() };
    const updateTaskStatus = jest.fn();
    const processor = new FileTaskProcessor(
      { updateTaskStatus, getFileTask: async () => null } as any,
      { delete: jest.fn() } as any,
      {} as any,
      {} as any,
    );
    (processor as any).logger = { error: jest.fn(), log: jest.fn(), debug: jest.fn() };
    /** Run the task as the queue does, and return the errorMessage it stores (BullMQ's failedReason = err.message). */
    const stored = async (): Promise<string> => {
      const err = await service.processZIpImport(TASK.id).then(
        () => {
          throw new Error('the import was expected to fail');
        },
        (e) => e,
      );
      expect(err).toBeInstanceOf(ImportTaskFailure);
      await processor.onFailed({ name: QueueJob.IMPORT_TASK, data: { fileTaskId: TASK.id }, failedReason: err.message } as any);
      expect(updateTaskStatus).toHaveBeenCalledWith(TASK.id, 'failed', err.message);
      return err.message;
    };
    return { db, service, stored };
  };
  const noServerPath = (message: string) => {
    expect(message).not.toContain(tmpdir());
    expect(message).not.toContain('docmost-extract');
  };

  it('an oversize page file in a real archive: refused by its archive path, before any transaction', async () => {
    const zip = await zipOf({ 'docs/ok.md': '# ok', 'docs/big.html': Buffer.alloc(CAP + 1, 97) });
    const { db, stored } = setup(async () => Readable.from([zip]));
    const message = await stored();
    expect(message).toBe("Import failed: 'docs/big.html' is 4.1 MB; each page file in an import is limited to 4 MB");
    expect(db.transaction).not.toHaveBeenCalled();
    noServerPath(message);
  });

  it('an error carrying the extract dir, from anywhere in the import, is stored without it', async () => {
    const zip = await zipOf({ 'docs/a.md': '# a' });
    const { service, stored } = setup(async () => Readable.from([zip]));
    let seen = '';
    jest.spyOn(service, 'processGenericImport').mockImplementationOnce(async ({ extractDir }) => {
      seen = extractDir;
      throw Object.assign(new Error(`EACCES: permission denied, scandir '${extractDir}/docs'`), { code: 'EACCES' });
    });
    const message = await stored();
    expect(seen).toContain('docmost-extract');
    expect(message).toBe('Import failed: the archive could not be read; try again later');
    expect(message).not.toContain(seen);
  });

  it('a download/extract failure is stored as an authored archive message', async () => {
    const { stored } = setup(async () => {
      throw new Error(`ENOENT: no such file or directory, open '${tmpdir()}/docmost-import-x.zip'`);
    });
    const message = await stored();
    expect(message).toBe('Import failed: the archive could not be processed');
    noServerPath(message);
  });
});
