/**
 * CCC #145 — convert one element of a document Turndown is already converting, without parsing a new one. Fork-owned.
 *
 * The `<details>` rule converts its summary and each child separately. Upstream passed them as HTML strings, and in
 * Node Turndown parses a string with `new JSDOM(…)` and never closes it: N toggles of M children left N × (M + 1)
 * unreleased windows inside one conversion, the accumulation #699 removed from the export. Turndown also takes a DOM
 * node (it deep-clones it within the same document), so this hands it one. Turndown converts a root's CHILDREN, so the
 * element is cloned into a wrapper of the same document to let its own rule fire, exactly as the string path
 * (`<x-turndown>` + outerHTML) did.
 */

interface TurndownLike {
  turndown(input: unknown): string;
}

export function turndownElement(turndownService: TurndownLike, element: Element): string {
  const wrapper = element.ownerDocument.createElement("div");
  wrapper.appendChild(element.cloneNode(true));
  return turndownService.turndown(wrapper);
}

/**
 * The `<details>` element's own `<summary>` (a direct child), as upstream's `querySelector(':scope > summary')` found
 * it, without a selector query: in jsdom one keeps the whole document reachable until the event loop turns, even after
 * `window.close()` (the #699 release; see strip-colgroup.ts).
 */
export function summaryOf(details: Element): Element | null {
  return Array.from(details.children).find((child) => child.nodeName === "SUMMARY") ?? null;
}
