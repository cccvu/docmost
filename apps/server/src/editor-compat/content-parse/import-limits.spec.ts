/**
 * #643: the per-file import bounds and their messages (pure helpers; the seams are pinned in
 * `import-limits.seams.spec.ts`).
 *
 * Run in CI via the `docmost-authz` job's jest glob (`… src/editor-compat …`).
 */
import { HttpException, PayloadTooLargeException } from '@nestjs/common';
import * as bytes from 'bytes';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { importFileSizeLimit, IMPORT_PAGE_FILE_BYTES, isImportPageFileName } from '@docmost/editor-ext';
import { CONTENT_PARSE_LIMITS, ContentTooComplexException, ConversionBudgetExhaustedException } from './content-parse.service';
import {
  assertImportHtmlWithinBounds,
  assertImportPageFileSize,
  assertZipPageFilesWithinCap,
  formatImportSize,
  IMPORT_LIMITS,
  ImportFileError,
  importTaskError,
  ImportTaskFailure,
  isImportPageFile,
  readImportUpload,
} from './import-limits';

const CAP = IMPORT_LIMITS.maxPageFileBytes;
const logger = () => ({ error: jest.fn(), warn: jest.fn() });

describe('#643 IMPORT_LIMITS', () => {
  it('Markdown may become 2× the file cap of HTML, which only ever LOWERS the worker cap', () => {
    expect(CAP).toBe(4 * 1024 * 1024);
    expect(IMPORT_LIMITS.maxMarkdownHtmlChars).toBe(2 * CAP);
    expect(IMPORT_LIMITS.maxMarkdownHtmlChars).toBeLessThanOrEqual(CONTENT_PARSE_LIMITS.maxChars);
  });

  it('the single-file limit in the message is the one import.controller.ts actually passes to req.file()', () => {
    const controller = readFileSync(resolve(__dirname, '../../integrations/import/import.controller.ts'), 'utf8');
    const importPage = controller.slice(controller.indexOf('async importPage('), controller.indexOf('async importZip('));
    const literal = /const maxFileSize = bytes\('([^']+)'\);/.exec(importPage)?.[1];
    expect(literal).toBeDefined();
    expect(bytes(literal as string)).toBe(IMPORT_LIMITS.singleFileBytes);
  });

  it('formats sizes as people read them, rounding an over-limit size up', () => {
    expect(formatImportSize(30 * 1024 * 1024)).toBe('30 MB');
    expect(formatImportSize(CAP)).toBe('4 MB');
    expect(formatImportSize(CAP + 1, true)).toBe('4.1 MB');
    expect(formatImportSize(12.3 * 1024 * 1024)).toBe('12.3 MB');
    expect(formatImportSize(512 * 1024)).toBe('512 KB');
  });

  it('page files are .md and .html, by extension or name', () => {
    expect(['.md', '.HTML', 'a/b.md', 'x.html'].map(isImportPageFile)).toEqual([true, true, true, true]);
    expect(['.docx', '.pdf', 'a.zip', 'md'].map(isImportPageFile)).toEqual([false, false, false, false]);
  });

  it('#716 I7: the page-file cap IS the shared number the SPA import modal checks, and both agree on page files', () => {
    expect(IMPORT_LIMITS.maxPageFileBytes).toBe(IMPORT_PAGE_FILE_BYTES);
    for (const name of ['a.md', 'b.HTML', 'c.Md', 'd.docx', 'e.pdf', 'f.zip', 'md']) {
      expect(isImportPageFileName(name)).toBe(isImportPageFile(name));
    }
    expect(importFileSizeLimit('page.md', IMPORT_LIMITS.singleFileBytes)).toBe(IMPORT_LIMITS.maxPageFileBytes);
    expect(importFileSizeLimit('scan.pdf', IMPORT_LIMITS.singleFileBytes)).toBe(IMPORT_LIMITS.singleFileBytes);
  });
});

describe('#643 readImportUpload: one honest 413 for the single-file upload limit', () => {
  const MESSAGE = 'File too large. The import limit is 30 MB';

  it("maps fastify's raw 413 (FST_REQ_FILE_TOO_LARGE) to the limit's own message", async () => {
    const fastify413 = Object.assign(new Error('request file too large'), { code: 'FST_REQ_FILE_TOO_LARGE', statusCode: 413 });
    const err = await readImportUpload({ toBuffer: () => Promise.reject(fastify413) }).catch((e) => e);
    expect(err).toBeInstanceOf(PayloadTooLargeException);
    expect(err.message).toBe(MESSAGE);
  });

  it('fails closed on a silently truncated buffer (the limit hit on the last chunk)', async () => {
    const err = await readImportUpload({
      toBuffer: () => Promise.resolve(Buffer.alloc(8)),
      file: { truncated: true },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(PayloadTooLargeException);
    expect(err.message).toBe(MESSAGE);
  });

  it('passes other errors and whole buffers through unchanged', async () => {
    const other = new Error('Part terminated early');
    await expect(readImportUpload({ toBuffer: () => Promise.reject(other) })).rejects.toBe(other);
    const buf = Buffer.from('ok');
    await expect(readImportUpload({ toBuffer: () => Promise.resolve(buf), file: { truncated: false } })).resolves.toBe(buf);
  });
});

describe('#643 assertImportPageFileSize', () => {
  it('a file at exactly the cap passes; one byte over is a 413 naming the file and the limit', () => {
    expect(() => assertImportPageFileSize(CAP, 'a.md')).not.toThrow();
    let err: HttpException | undefined;
    try {
      assertImportPageFileSize(CAP + 1, 'big.html');
    } catch (e) {
      err = e as HttpException;
    }
    expect(err).toBeInstanceOf(PayloadTooLargeException);
    expect(err?.message).toBe(
      "File too large. 'big.html' is 4.1 MB; each page file in an import is limited to 4 MB",
    );
  });
});

describe('#643 assertImportHtmlWithinBounds: the markup cheerio may load', () => {
  it('exactly maxHtmlTags tags pass; one more is 422 content_too_complex, logged', () => {
    const log = logger();
    expect(() => assertImportHtmlWithinBounds('<b>'.repeat(IMPORT_LIMITS.maxHtmlTags), log)).not.toThrow();
    expect(() => assertImportHtmlWithinBounds('<b>'.repeat(IMPORT_LIMITS.maxHtmlTags + 1), log)).toThrow(
      ContentTooComplexException,
    );
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('IMPORT_TOO_COMPLEX reason=tags'));
  });
});

describe('#643 assertZipPageFilesWithinCap: the zip pre-flight', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'docmost-extract-'));
    mkdirSync(join(dir, 'docs', 'deep'), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const file = (rel: string, size: number) => {
    writeFileSync(join(dir, rel), Buffer.alloc(size, 97));
    return join(dir, rel);
  };

  it('passes files at exactly the cap', async () => {
    await expect(assertZipPageFilesWithinCap(dir, [file('a.md', CAP), file('docs/b.html', 10)])).resolves.toBeUndefined();
  });

  it('refuses naming up to three files by their path IN THE ARCHIVE, never the extract dir', async () => {
    const files = [
      file('ok.md', 10),
      file('docs/big.html', 12.25 * 1024 * 1024),
      file('docs/deep/a.md', CAP + 1),
      file('b.md', CAP + 1),
      file('c.md', CAP + 1),
      file('d.md', CAP + 1),
    ];
    const err = await assertZipPageFilesWithinCap(dir, files).catch((e) => e);
    expect(err).toBeInstanceOf(PayloadTooLargeException);
    expect(err.message).toBe(
      "'docs/big.html' is 12.3 MB, 'docs/deep/a.md' is 4.1 MB, 'b.md' is 4.1 MB, and 2 more; " +
        'each page file in an import is limited to 4 MB',
    );
    expect(err.message).not.toContain(dir);
  });

  it('a file it cannot stat fails as that file, and its message carries no server path', async () => {
    const missing = join(dir, 'docs', 'gone.md');
    const err = await assertZipPageFilesWithinCap(dir, [missing]).catch((e) => e);
    expect(err).toBeInstanceOf(ImportFileError);
    const log = logger();
    const shown = importTaskError(err, { logger: log });
    expect(shown.message).toBe('Import failed: docs/gone.md: it is missing from the archive');
    expect(shown.message).not.toContain(dir);
    expect(log.error).toHaveBeenCalled(); // the raw error (with its path) stays in the server log
  });
});

describe('#643 importTaskError: a zip task fails only with messages we wrote', () => {
  const extractDir = '/tmp/docmost-extract-AbC123';
  const fsError = (code: string) =>
    Object.assign(new Error(`${code}: failed, open '${extractDir}/docs/a.md'`), { code, path: `${extractDir}/docs/a.md` });

  it('#642: a converter budget the batch wait could not cover is an authored failure naming the zip entry, never a tmp path', () => {
    const log = logger();
    const err = importTaskError(new ConversionBudgetExhaustedException(40), { file: 'docs/a.md', logger: log });
    expect(err).toBeInstanceOf(ImportTaskFailure);
    expect(err.message).toBe(
      'Import failed: docs/a.md: this account is using the content converter heavily; retry in 40 s',
    );
    expect(err.message).not.toContain(extractDir);
  });

  it('an fs error becomes "Import failed: <path>: <reason>"; the raw error is logged, never shown', () => {
    const log = logger();
    const err = importTaskError(fsError('ENAMETOOLONG'), { file: 'docs/a.md', logger: log });
    expect(err).toBeInstanceOf(ImportTaskFailure);
    expect(err.message).toBe('Import failed: docs/a.md: its path is too long');
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('IMPORT_TASK_FAILED'), expect.any(Error));
    expect(importTaskError(fsError('EMFILE'), { file: 'docs/a.md', logger: log }).message).toBe(
      'Import failed: docs/a.md: it could not be read; try again later',
    );
    expect(importTaskError(new TypeError(`x at ${extractDir}`), { file: 'docs/a.md', logger: log }).message).toBe(
      'Import failed: docs/a.md: it could not be imported',
    );
  });

  it('with no page in hand it names the archive', () => {
    const log = logger();
    expect(importTaskError(fsError('EIO'), { logger: log }).message).toBe(
      'Import failed: the archive could not be read; try again later',
    );
    expect(importTaskError(new Error(`invalid relative path: ${extractDir}`), { logger: log }).message).toBe(
      'Import failed: the archive could not be processed',
    );
  });

  it("keeps our HTTP refusals and extractZip's own refusals, prefixed with the page when known", () => {
    const log = logger();
    expect(importTaskError(new ContentTooComplexException(), { file: 'docs/a.md', logger: log }).message).toBe(
      'Import failed: docs/a.md: The content is too large or complex to convert in one write, so it was not applied. ' +
        'Split it into smaller pages, or add it in parts with append.',
    );
    expect(importTaskError(new PayloadTooLargeException("'x.md' is 5 MB"), { logger: log }).message).toBe(
      "Import failed: 'x.md' is 5 MB",
    );
    expect(
      importTaskError(new Error('Import archive has too many entries'), { logger: log }).message,
    ).toBe('Import failed: Import archive has too many entries');
    expect(log.error).not.toHaveBeenCalled();
  });

  it('is idempotent: an already-worded failure passes through the outer handler unchanged', () => {
    const once = importTaskError(fsError('ENOENT'), { file: 'a.md', logger: logger() });
    expect(importTaskError(once, { logger: logger() })).toBe(once);
  });
});
