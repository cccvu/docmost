import { afterEach, describe, expect, it } from "vitest";
import { passkeyFocusTarget } from "./passkey-focus.ts";

// #907: where focus goes when the remove dialog closes. Never <body>.

afterEach(() => {
  document.body.innerHTML = "";
});

function page() {
  document.body.innerHTML = `
    <section>
      <h2 tabindex="-1">Passkeys</h2>
      <button data-passkey-action="a">Remove A</button>
      <button data-passkey-action="b">Try again B</button>
    </section>`;
  const section = document.querySelector("section")!;
  const [a, b] = Array.from(section.querySelectorAll("button"));
  return { section, heading: section.querySelector("h2")!, a, b };
}

describe("passkeyFocusTarget", () => {
  it("the trigger, while it is on the page", () => {
    const { section, heading, a } = page();
    expect(
      passkeyFocusTarget(
        { trigger: a, passkeyId: "a", toHeading: false },
        section,
        heading,
      ),
    ).toBe(a);
  });

  it("the same row's current action once the trigger was replaced", () => {
    const { section, heading, b } = page();
    const detached = document.createElement("button");
    expect(
      passkeyFocusTarget(
        { trigger: detached, passkeyId: "b", toHeading: false },
        section,
        heading,
      ),
    ).toBe(b);
  });

  it("the heading when the row is gone", () => {
    const { section, heading, a } = page();
    a.remove();
    expect(
      passkeyFocusTarget(
        { trigger: a, passkeyId: "a", toHeading: false },
        section,
        heading,
      ),
    ).toBe(heading);
  });

  it("the heading after a removal, even while the row is still there", () => {
    const { section, heading, a } = page();
    expect(
      passkeyFocusTarget(
        { trigger: a, passkeyId: "a", toHeading: true },
        section,
        heading,
      ),
    ).toBe(heading);
  });

  it("nothing (never <body>) when no target is on the page", () => {
    const { section, heading, a } = page();
    section.remove();
    expect(
      passkeyFocusTarget(
        { trigger: a, passkeyId: "a", toHeading: false },
        section,
        heading,
      ),
    ).toBeNull();
    expect(
      passkeyFocusTarget(
        { trigger: null, passkeyId: "a", toHeading: true },
        null,
        null,
      ),
    ).toBeNull();
  });
});
