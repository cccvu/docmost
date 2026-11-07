// #145: the roving-tabindex hook must (1) initialise when the toolbar element mounts AFTER the hook's first
// render (FixedToolbar returns null until the page editor is in its atom, i.e. every Edit-default page load),
// and (2) keep exactly one tab stop as controls are disabled / re-enabled (Undo/Redo start disabled; the font
// menus disable inside a code block).
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { useRovingToolbar } from "./use-roving-toolbar";

// jsdom has no layout, so offsetParent is always null and the hook would treat every control as hidden.
const offsetParentDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetParent",
);
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      return (this as HTMLElement).parentNode;
    },
  });
});
afterAll(() => {
  if (offsetParentDescriptor)
    Object.defineProperty(
      HTMLElement.prototype,
      "offsetParent",
      offsetParentDescriptor,
    );
});
afterEach(cleanup);

interface HarnessProps {
  show?: boolean;
  disabled?: Partial<Record<"a" | "b" | "c", boolean>>;
  onExit?: () => void;
}

function Harness({ show = true, disabled = {}, onExit }: HarnessProps) {
  const ref = useRef<HTMLDivElement>(null);
  useRovingToolbar(ref, onExit);
  // Mirrors FixedToolbar: the hook runs on every render, the toolbar element only once ready.
  if (!show) return null;
  return (
    <div role="toolbar" ref={ref}>
      <button disabled={disabled.a}>A</button>
      <button disabled={disabled.b}>B</button>
      <button disabled={disabled.c}>C</button>
    </div>
  );
}

const button = (name: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === name,
  ) as HTMLButtonElement;

// A tab stop = an enabled control in the sequential focus order (tabIndex >= 0; a button defaults to 0).
const tabStops = () =>
  Array.from(document.querySelectorAll("button"))
    .filter((b) => !b.disabled && b.tabIndex >= 0)
    .map((b) => b.textContent);

// MutationObserver callbacks are delivered as a microtask.
const flushObservers = () => act(async () => {});

describe("useRovingToolbar", () => {
  it("initialises when the toolbar mounts after the hook's first render", async () => {
    const { rerender } = render(<Harness show={false} />);
    rerender(<Harness show />);
    await flushObservers();

    expect(tabStops()).toEqual(["A"]);

    button("A").focus();
    fireEvent.keyDown(button("A"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(button("B"));
    expect(tabStops()).toEqual(["B"]);
  });

  it("supports Home / End / ArrowLeft wrap and Escape", () => {
    const onExit = vi.fn();
    render(<Harness onExit={onExit} />);

    button("A").focus();
    fireEvent.keyDown(button("A"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(button("C"));
    fireEvent.keyDown(button("C"), { key: "Home" });
    expect(document.activeElement).toBe(button("A"));
    fireEvent.keyDown(button("A"), { key: "End" });
    expect(document.activeElement).toBe(button("C"));

    fireEvent.keyDown(button("C"), { key: "Escape" });
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("calls the latest onExit without re-initialising the roving stop", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Harness onExit={first} />);
    button("B").focus(); // moves the roving stop to B
    rerender(<Harness onExit={second} />);

    expect(tabStops()).toEqual(["B"]);
    fireEvent.keyDown(button("B"), { key: "Escape" });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("keeps a tab stop when the active control becomes disabled", async () => {
    const { rerender } = render(<Harness />);
    expect(tabStops()).toEqual(["A"]);

    rerender(<Harness disabled={{ a: true }} />);
    await flushObservers();
    expect(tabStops()).toEqual(["B"]);
  });

  it("does not add a second tab stop when a disabled control is re-enabled", async () => {
    const { rerender } = render(<Harness disabled={{ c: true }} />);
    expect(tabStops()).toEqual(["A"]);

    rerender(<Harness />);
    await flushObservers();
    expect(tabStops()).toEqual(["A"]);
  });

  it("keeps the current stop when the previously active control is re-enabled", async () => {
    const { rerender } = render(<Harness />);
    rerender(<Harness disabled={{ a: true }} />);
    await flushObservers();
    expect(tabStops()).toEqual(["B"]);

    rerender(<Harness />);
    await flushObservers();
    expect(tabStops()).toEqual(["B"]);
  });
});
