import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import bytes from "bytes";
import { IMPORT_PAGE_FILE_BYTES, importFileSizeLimit, isImportPageFileName } from "@docmost/editor-ext";

/**
 * CCC #716 I7 — the import modal checks a .md/.html file against the engine's page-file limit (4 MiB), not the 30 MB
 * upload limit, so a 5 MB Markdown file is refused before it uploads instead of failing on the server.
 */
describe("import page-file limit (#716 I7)", () => {
  const upload = bytes("30mb") as number;

  it("is 4 MiB for .md and .html (any case), and the upload limit for everything else", () => {
    expect(IMPORT_PAGE_FILE_BYTES).toBe(4 * 1024 * 1024);
    for (const name of ["notes.md", "Notes.MD", "page.html", "x.HTML"]) {
      expect(isImportPageFileName(name)).toBe(true);
      expect(importFileSizeLimit(name, upload)).toBe(IMPORT_PAGE_FILE_BYTES);
    }
    for (const name of ["report.docx", "scan.pdf", "md", "notes.markdown"]) {
      expect(isImportPageFileName(name)).toBe(false);
      expect(importFileSizeLimit(name, upload)).toBe(upload);
    }
  });

  it("a 5 MB Markdown file is over its limit, a 5 MB docx is not", () => {
    const five = 5 * 1024 * 1024;
    expect(five > importFileSizeLimit("big.md", upload)).toBe(true);
    expect(five > importFileSizeLimit("big.docx", upload)).toBe(false);
  });

  it("the import modal applies it per file, and names the limit that file broke", () => {
    const src = readFileSync(join(__dirname, "../page/components/page-import-modal.tsx"), "utf8");
    expect(src).toMatch(/import \{ importFileSizeLimit \} from "@docmost\/editor-ext"/);
    expect(src).toMatch(/f\.size > importFileSizeLimit\(f\.name, maxSingleFileSize\)/);
    expect(src).toMatch(/formatBytes\(importFileSizeLimit\(oversizedFiles\[0\]\.name, maxSingleFileSize\)\)/);
    expect(src).not.toMatch(/f\.size > maxSingleFileSize/);
  });
});
