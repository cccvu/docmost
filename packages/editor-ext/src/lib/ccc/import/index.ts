/**
 * CCC (#643, #716 I7) — the one size limit for an imported page file, shared by the engine and the SPA. Fork-owned.
 *
 * The engine refuses a .md/.html page file over this many bytes (`IMPORT_LIMITS.maxPageFileBytes`, apps/server
 * editor-compat/content-parse/import-limits.ts: one cheerio pass over 4 MiB of real content is ~0.5 s and ~175 MB of
 * heap on the main thread). The import modal checks the same number before it uploads, so a person sees the real limit
 * at once instead of a 30 MB check that lets a 5 MB Markdown file upload and then fail.
 */
export const IMPORT_PAGE_FILE_BYTES = 4 * 1024 * 1024;

/** Whether a file is a page file (.md or .html) that the page-file limit applies to. */
export function isImportPageFileName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".html");
}

/** The size limit for one file in a single-file import: the page-file limit for .md/.html, else `otherLimit`. */
export function importFileSizeLimit(fileName: string, otherLimit: number): number {
  return isImportPageFileName(fileName) ? Math.min(IMPORT_PAGE_FILE_BYTES, otherLimit) : otherLimit;
}
