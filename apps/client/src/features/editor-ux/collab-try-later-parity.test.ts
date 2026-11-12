// cccvu/wiki-v2#810 — the editor reacts to the server's collab refusals by their reason strings and close codes, and
// keeps its own copies of them (collab-access.ts). This reads the SERVER's source and holds the copies equal, so a
// renamed reason or code on either side goes red here instead of silently turning a pace hint into the #537 path (a
// token refetch, then "connection lost") or a refusal into a retry loop.
//
// Where the server keeps them moves (auth-refusal.ts holds the connect's refusal reasons since #810; auth-rate.ts and
// user-connections.ts held them before; collab-reasons.ts holds #827's), so the constants are found by NAME in
// whichever of these files exist.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COLLAB_EPOCH_PATTERN,
  COLLAB_EPOCH_STALE_PREFIX,
  COLLAB_LOAD_TRY_LATER_REASON,
  COLLAB_PAGE_COMPACTING_REASON,
  COLLAB_RULE_APPLY_DEADLINE,
  COLLAB_RULE_FRAME_TOO_LARGE,
  COLLAB_RULE_PAGE_FULL,
  COLLAB_UPDATE_REFUSED_PREFIX,
  COLLAB_UPDATE_UNRESOLVED,
  classifyCollabCloseReason,
  collabRefusalKind,
  parseEpochStaleReason,
  TRY_LATER_AUTH_REASONS,
  TRY_LATER_CLOSE_CODES,
  TRY_LATER_CLOSE_REASONS,
  WS_CLOSE_MESSAGE_TOO_BIG,
} from "./collab-access";
import {
  COLLAB_LOCAL_COPY_RULE,
  COLLAB_REFUSAL_RULES,
  collabRefusalCause,
} from "./collab-refusal-cause";

const INGRESS = join(__dirname, "../../../../server/src/authz/collab-ingress");
const FILES = [
  "auth-refusal.ts",
  "auth-rate.ts",
  "user-connections.ts",
  "update-guard.ts",
  "bounded-socket.ts",
  "collab-reasons.ts", // #827
];

const present = FILES.filter((f) => existsSync(join(INGRESS, f)));
const source = present
  .map((f) => readFileSync(join(INGRESS, f), "utf8"))
  .join("\n");

/** `export const NAME = '...'` (or a number) in the server source; undefined when absent. */
function serverConst(name: string): string | undefined {
  const m = source.match(
    new RegExp(
      `export const ${name}\\s*=\\s*(?:'([^']*)'|"([^"]*)"|(\\d+))\\s*;`,
    ),
  );
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

/** Every `ccc:collab-…` string literal in the server source (comments included only when quoted). */
const serverReasons = [
  ...new Set(
    [...source.matchAll(/['"`](ccc:collab-[A-Za-z0-9:_-]*)['"`]/g)].map(
      (m) => m[1],
    ),
  ),
];

describe("server ↔ client collab reasons (#810)", () => {
  it("is not vacuous: the server files were read and the constants found", () => {
    expect(present.length).toBeGreaterThanOrEqual(3);
    for (const name of [
      "COLLAB_AUTH_RATE_REASON",
      "COLLAB_USER_CONNECTIONS_REASON",
      "TRY_LATER_REASON",
      "COLLAB_TRY_LATER_CODE",
      "COLLAB_USER_CONNECTIONS_CLOSE_CODE",
      "REFUSED_REASON_PREFIX",
      "UNRESOLVED_REASON",
      "COLLAB_PAGE_COMPACTING_REASON",
      "COLLAB_LOAD_TRY_LATER_REASON",
      "COLLAB_EPOCH_STALE_REASON_PREFIX",
      "RULE_FRAME_TOO_LARGE",
      "RULE_APPLY_DEADLINE",
      "RULE_PAGE_FULL",
    ]) {
      expect([name, serverConst(name)]).toEqual([name, expect.any(String)]);
    }
    expect(serverReasons.length).toBeGreaterThanOrEqual(5);
  });

  it("the auth refusals the editor waits out are the server's auth-rate, connection-cap and load-debt reasons", () => {
    expect([...TRY_LATER_AUTH_REASONS].sort()).toEqual(
      [
        serverConst("COLLAB_AUTH_RATE_REASON"),
        serverConst("COLLAB_USER_CONNECTIONS_REASON"),
        serverConst("COLLAB_LOAD_TRY_LATER_REASON"),
      ].sort(),
    );
  });

  it("the closes the editor waits out are the server's try-later and connection-cap reasons and codes", () => {
    expect([...TRY_LATER_CLOSE_REASONS].sort()).toEqual(
      [
        serverConst("TRY_LATER_REASON"),
        serverConst("COLLAB_USER_CONNECTIONS_REASON"),
        serverConst("COLLAB_LOAD_TRY_LATER_REASON"),
      ].sort(),
    );
    expect([...TRY_LATER_CLOSE_CODES].sort()).toEqual(
      [
        Number(serverConst("COLLAB_TRY_LATER_CODE")),
        Number(serverConst("COLLAB_USER_CONNECTIONS_CLOSE_CODE")),
      ].sort(),
    );
  });

  it("the update guard's refusal reasons are the client's", () => {
    expect(serverConst("REFUSED_REASON_PREFIX")).toBe(
      COLLAB_UPDATE_REFUSED_PREFIX,
    );
    expect(serverConst("UNRESOLVED_REASON")).toBe(COLLAB_UPDATE_UNRESOLVED);
    expect(WS_CLOSE_MESSAGE_TOO_BIG).toBe(1009);
  });

  // #827: the page-level reasons and the Discard-first rules.
  it("the compaction, load-debt and epoch-stale reasons and the Discard-first rules are the client's", () => {
    expect(serverConst("COLLAB_PAGE_COMPACTING_REASON")).toBe(
      COLLAB_PAGE_COMPACTING_REASON,
    );
    expect(serverConst("COLLAB_LOAD_TRY_LATER_REASON")).toBe(
      COLLAB_LOAD_TRY_LATER_REASON,
    );
    expect(serverConst("COLLAB_EPOCH_STALE_REASON_PREFIX")).toBe(
      COLLAB_EPOCH_STALE_PREFIX,
    );
    expect(serverConst("RULE_FRAME_TOO_LARGE")).toBe(COLLAB_RULE_FRAME_TOO_LARGE);
    expect(serverConst("RULE_APPLY_DEADLINE")).toBe(COLLAB_RULE_APPLY_DEADLINE);
    expect(serverConst("RULE_PAGE_FULL")).toBe(COLLAB_RULE_PAGE_FULL);
    for (const rule of [
      COLLAB_RULE_FRAME_TOO_LARGE,
      COLLAB_RULE_APPLY_DEADLINE,
      COLLAB_RULE_PAGE_FULL,
    ]) {
      expect(collabRefusalKind(COLLAB_UPDATE_REFUSED_PREFIX + rule)).not.toBe("generic");
    }
  });

  // The server's parseEpochStaleReason and the client's must read the same epochs (the server's own spec vectors).
  it("the client reads an epoch-stale reason as the server writes it", () => {
    const pattern = source.match(
      /export function parseEpochStaleReason[\s\S]*?if \(!(\/.*\/)\.test\(tail\)\)/,
    );
    expect(pattern?.[1]).toBe(String(COLLAB_EPOCH_PATTERN));
    for (const n of [0, 1, 42, 999_999_999_999_999]) {
      expect(parseEpochStaleReason(COLLAB_EPOCH_STALE_PREFIX + n)).toBe(n);
    }
    for (const bad of ["", "-1", "01", "1e3", "1 ", "x"]) {
      expect(parseEpochStaleReason(COLLAB_EPOCH_STALE_PREFIX + bad)).toBeNull();
    }
  });

  // A NEW server reason must be a decision on the client too (refused, epoch, unresolved, compacting or try later),
  // never "other" by default: a reason the editor does not know takes the #537 path (auth) or the provider's 1 s
  // reconnect (close).
  it("every ccc:collab reason the server sends is one the client classifies", () => {
    const known = (r: string) =>
      r === COLLAB_UPDATE_REFUSED_PREFIX ||
      r.startsWith(COLLAB_UPDATE_REFUSED_PREFIX) ||
      r === COLLAB_UPDATE_UNRESOLVED ||
      r === COLLAB_PAGE_COMPACTING_REASON ||
      TRY_LATER_AUTH_REASONS.includes(r) ||
      TRY_LATER_CLOSE_REASONS.includes(r);
    expect(serverReasons.filter((r) => !known(r))).toEqual([]);
    expect(classifyCollabCloseReason(COLLAB_PAGE_COMPACTING_REASON, 1013)).toBe("compacting");
    expect(classifyCollabCloseReason(`${COLLAB_EPOCH_STALE_PREFIX}2`, 1000)).toBe("epoch");
  });
});

// The ledger-echo incident (#781 lineage) — the refusal notice's copy follows the rule the server refused on
// (collab-refusal-cause.ts). Every rule in the server's `CollabRule` union must be a decision on the client: exactly one
// cause. A new or renamed server rule goes red here until it joins one. The client and server ship in one image, so the
// two lists are equal; an older cached bundle that meets a newer rule falls back to `other` (collabRefusalCause).

describe("server CollabRule ↔ client refusal causes", () => {
  const rulesSource = readFileSync(join(INGRESS, "content-rules.ts"), "utf8");
  const union = rulesSource.match(
    /export type CollabRule\s*=\s*((?:\s*\|\s*'[a-z-]+')+)\s*;/,
  );
  const serverRules = union
    ? [...union[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1])
    : [];
  const causes = Object.entries(COLLAB_REFUSAL_RULES) as [
    string,
    ReadonlySet<string>,
  ][];

  it("is not vacuous: the server union was read in full", () => {
    expect(union).not.toBeNull();
    expect(serverRules.length).toBeGreaterThanOrEqual(28);
    for (const rule of ["root", "schema", "internal", "unresolved"]) {
      expect(serverRules).toContain(rule);
    }
    expect(new Set(serverRules).size).toBe(serverRules.length);
  });

  it("every server rule is in exactly one cause", () => {
    const misplaced = serverRules
      .map((rule) => [rule, causes.filter(([, set]) => set.has(rule)).map(([c]) => c)] as const)
      .filter(([, inCauses]) => inCauses.length !== 1);
    expect(misplaced).toEqual([]);
    for (const rule of serverRules) {
      expect([rule, collabRefusalCause(rule)]).toEqual([
        rule,
        causes.find(([, set]) => set.has(rule))?.[0],
      ]);
    }
  });

  it("every client entry is a server rule", () => {
    const server = new Set(serverRules);
    const extra = causes.flatMap(([cause, set]) =>
      [...set].filter((rule) => !server.has(rule)).map((rule) => `${cause}:${rule}`),
    );
    expect(extra).toEqual([]);
    expect(collabRefusalCause("not-a-rule-yet")).toBe("other");
  });

  // #847: the client's own rule (a broken local copy) is the copy cause, outside every set, and never a server rule
  it("the client's local-copy rule matches no server rule and stays out of the cause sets", () => {
    expect(serverRules).not.toContain(COLLAB_LOCAL_COPY_RULE);
    expect(COLLAB_LOCAL_COPY_RULE).not.toMatch(/^[a-z-]+$/); // the server's rule alphabet
    expect(causes.filter(([, set]) => set.has(COLLAB_LOCAL_COPY_RULE))).toEqual([]);
    expect(collabRefusalCause(COLLAB_LOCAL_COPY_RULE)).toBe("copy");
  });

  it("the cause sets are disjoint", () => {
    const all = causes.flatMap(([, set]) => [...set]);
    expect(new Set(all).size).toBe(all.length);
    for (const [, set] of causes) expect(set).toBeInstanceOf(Set);
  });
});
