// cccvu/wiki-v2#781 — the server's collab ingress guard refuses a frame that names a node or mark its schema does
// not know. The browser builds its documents from `mainExtensions`, so every node and mark the client schema can
// produce must be one the server knows, or an honest editor is refused (read-only + the refusal notice) the first
// time it uses the new node. A new node or mark therefore lands on BOTH schemas and in the server snapshot.
//
// The barrel imports src/main.tsx (which mounts the app on #root) through the page queries; stub it so the barrel
// evaluates under jsdom without mounting anything.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getSchema } from "@tiptap/core";

vi.mock("@/main.tsx", () => ({ queryClient: {} }));

import { mainExtensions } from "@/features/editor/extensions/extensions";

/**
 * The server schema's names, as the collab ingress guard knows them: the server's committed snapshot, which its
 * schema-names.spec.ts holds equal to the real server schema. Read, not copied, so the two can never drift apart.
 */
const SERVER_SCHEMA: { nodes: string[]; marks: string[] } = JSON.parse(
  readFileSync(
    join(__dirname, "../../../../server/src/authz/collab-ingress/schema-names.snapshot.json"),
    "utf8",
  ),
);

describe("client collab schema ⊆ the server's (#781)", () => {
  const schema = getSchema(mainExtensions);
  const clientNodes = Object.keys(schema.nodes);
  const clientMarks = Object.keys(schema.marks);

  it("is not vacuous: the server snapshot was read", () => {
    expect(SERVER_SCHEMA.nodes).toEqual(expect.arrayContaining(["doc", "paragraph", "text"]));
    expect(SERVER_SCHEMA.marks).toEqual(expect.arrayContaining(["bold", "link"]));
  });

  it("is not vacuous: the client schema has the core nodes and marks", () => {
    expect(clientNodes).toEqual(
      expect.arrayContaining(["doc", "paragraph", "text", "table", "mention"]),
    );
    expect(clientMarks).toEqual(
      expect.arrayContaining(["bold", "link", "comment"]),
    );
  });

  it("every client node is a server node", () => {
    expect(clientNodes.filter((n) => !SERVER_SCHEMA.nodes.includes(n))).toEqual(
      [],
    );
  });

  it("every client mark is a server mark", () => {
    expect(clientMarks.filter((m) => !SERVER_SCHEMA.marks.includes(m))).toEqual(
      [],
    );
  });
});
