import { afterEach, describe, expect, it } from "vitest";
import { restoreFocus } from "./focus-fallback";

function button(label: string, attach = true): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  if (attach) document.body.appendChild(b);
  return b;
}

describe("restoreFocus", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does nothing while a connected element still holds focus", () => {
    const keep = button("keep");
    const other = button("other");
    keep.focus();
    expect(restoreFocus(other)).toBeNull();
    expect(document.activeElement).toBe(keep);
  });

  it("focuses the first connected, enabled candidate when focus fell to <body>", () => {
    const detached = button("gone", false);
    const disabled = button("disabled");
    disabled.disabled = true;
    const target = button("target");
    expect(document.activeElement).toBe(document.body);
    expect(restoreFocus(null, undefined, detached, disabled, target)).toBe(target);
    expect(document.activeElement).toBe(target);
  });

  it("recovers when the focused element was removed from the document", () => {
    const row = button("row");
    const heading = document.createElement("h2");
    heading.tabIndex = -1;
    document.body.appendChild(heading);
    row.focus();
    row.remove();
    expect(restoreFocus(heading)).toBe(heading);
    expect(document.activeElement).toBe(heading);
  });

  it("focuses nothing when no candidate is usable", () => {
    expect(restoreFocus(null, button("x", false))).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});
