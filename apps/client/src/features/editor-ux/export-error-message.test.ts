import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXPORT_FAILED_FALLBACK,
  exportErrorMessage,
} from "./export-error-message";

/**
 * CCC #716 review: the export modal requests a Blob, so an engine refusal's JSON body arrives as a Blob. The toast must
 * show the engine's message ("Export it as HTML…"), never "undefined".
 */
const blobErr = (body: string, type = "application/json") => ({
  response: { status: 422, data: new Blob([body], { type }) },
});

describe("exportErrorMessage (#716 review)", () => {
  it("reads the engine's message out of a Blob error body", async () => {
    const msg =
      "A page in this export is too large or complex to convert within the limits. Export it as HTML, or export a smaller page.";
    expect(
      await exportErrorMessage(
        blobErr(
          JSON.stringify({
            message: msg,
            code: "export_too_large",
            statusCode: 422,
          }),
        ),
      ),
    ).toBe(msg);
  });

  it("reads a plain-object body too, and joins a validation message list", async () => {
    expect(
      await exportErrorMessage({ response: { data: { message: "busy" } } }),
    ).toBe("busy");
    expect(
      await exportErrorMessage({
        response: { data: { message: ["a", "", "b"] } },
      }),
    ).toBe("a; b");
  });

  it("falls back for no response, a non-JSON body, a message-less body and an oversized body", async () => {
    for (const err of [
      new Error("Network Error"),
      null,
      blobErr("<html>bad gateway</html>", "text/html"),
      blobErr(JSON.stringify({ code: "x" })),
      blobErr(JSON.stringify({ message: "x".repeat(20_000) })),
    ]) {
      expect(await exportErrorMessage(err)).toBe(EXPORT_FAILED_FALLBACK);
    }
  });

  it("the export modal uses it (the seam), not the raw blob's `.message`", () => {
    const src = readFileSync(
      join(__dirname, "../../components/common/export-modal.tsx"),
      "utf8",
    );
    expect(src).toMatch(
      /import \{ exportErrorMessage \} from "@\/features\/editor-ux\/export-error-message"/,
    );
    expect(src).toMatch(
      /"Export failed: " \+ \(await exportErrorMessage\(err\)\)/,
    );
    expect(src).not.toMatch(/err\.response\?\.data\.message/);
  });
});
