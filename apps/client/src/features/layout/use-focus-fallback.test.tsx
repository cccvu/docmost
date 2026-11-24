import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import {
  enclosingTab,
  FOCUS_FALLBACK_ARM_MS,
  FOCUS_FALLBACK_DIALOG_WAIT_MS,
  useFocusFallback,
} from "./use-focus-fallback";

// wiki-v2 #913: a confirmed delete/restore removes its trigger only after the mutation and refetch commit.
// The armed fallback must catch that commit (a list that re-renders without the row) or the unmount (a row
// that removes itself), and must never move focus that something still holds.
// The test drives the hook through buttons: fireEvent.click does not move focus in jsdom.
function List() {
  const arm = useFocusFallback();
  const [rows, setRows] = useState(["a"]);
  return (
    <>
      {rows.map((r) => (
        <button key={r}>{r}</button>
      ))}
      <button>other</button>
      <span data-testid="arm" onClick={arm} />
      <span data-testid="same" onClick={() => setRows([...rows])} />
      <span data-testid="remove" onClick={() => setRows([])} />
      <span data-testid="add" onClick={() => setRows(["b"])} />
    </>
  );
}

function Row() {
  const arm = useFocusFallback();
  return (
    <>
      <button>row</button>
      <span data-testid="arm" onClick={arm} />
    </>
  );
}

function Host({ showRow }: { showRow: boolean }) {
  return showRow ? <Row /> : null;
}

function renderInMain(ui: React.ReactElement) {
  const view = render(
    <main id="main-content" tabIndex={-1}>
      {ui}
    </main>,
  );
  return view;
}

const click = (id: string) => fireEvent.click(screen.getByTestId(id));
const byText = (label: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === label,
  )!;

afterEach(() => {
  cleanup();
  document.querySelectorAll("[data-closing-dialog]").forEach((d) => d.remove());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useFocusFallback (#913)", () => {
  it("armed: no move while the trigger holds focus; the commit that removes it moves focus to main", () => {
    renderInMain(<List />);
    byText("a").focus();
    click("arm");
    click("same"); // an unrelated commit: the trigger still holds focus
    expect(document.activeElement).toBe(byText("a"));
    click("remove");
    expect(document.activeElement?.id).toBe("main-content");
  });

  it("not armed: the same removal leaves focus where it fell", () => {
    renderInMain(<List />);
    byText("a").focus();
    click("remove");
    expect(document.activeElement).toBe(document.body);
  });

  it("armed row that unmounts itself: focus moves to main", () => {
    const view = renderInMain(<Host showRow />);
    byText("row").focus();
    click("arm");
    view.rerender(
      <main id="main-content" tabIndex={-1}>
        <Host showRow={false} />
      </main>,
    );
    expect(document.activeElement?.id).toBe("main-content");
  });

  it("focus the user moved elsewhere is kept", () => {
    renderInMain(<List />);
    byText("a").focus();
    click("arm");
    byText("other").focus();
    click("remove");
    expect(document.activeElement).toBe(byText("other"));
  });

  it(`disarms after ${FOCUS_FALLBACK_ARM_MS} ms`, () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    renderInMain(<List />);
    byText("a").focus();
    click("arm");
    now.mockReturnValue(1_000 + FOCUS_FALLBACK_ARM_MS + 1);
    click("remove");
    expect(document.activeElement).toBe(document.body);
  });

  it("disarms once it moved focus: a later loss is left alone", () => {
    renderInMain(<List />);
    byText("a").focus();
    click("arm");
    click("remove");
    expect(document.activeElement?.id).toBe("main-content");
    (document.activeElement as HTMLElement).blur();
    click("add");
    expect(document.activeElement).toBe(document.body);
  });
});

// wiki-v2 #858/#913: a removal outside the main content (a comment in the aside) names its own target, tried
// before the main content.
function TabbedRow({ getTarget }: { getTarget?: () => HTMLElement | null }) {
  const arm = useFocusFallback(getTarget);
  return (
    <>
      <button>row</button>
      <span data-testid="arm" onClick={() => arm()} />
    </>
  );
}

function renderTabbed(showRow: boolean, getTarget?: () => HTMLElement | null) {
  return (
    <main id="main-content" tabIndex={-1}>
      <div role="tablist">
        <button role="tab" id="tab-open">
          Open
        </button>
      </div>
      <div role="tabpanel" aria-labelledby="tab-open">
        {showRow ? <TabbedRow getTarget={getTarget} /> : null}
      </div>
    </main>
  );
}

describe("useFocusFallback target (#858)", () => {
  it("moves focus to the caller's target, read when focus is restored", () => {
    let target: HTMLElement | null = null;
    const getTarget = () => target;
    const view = render(renderTabbed(true, getTarget));
    byText("row").focus();
    target = enclosingTab(byText("row"));
    click("arm");
    view.rerender(renderTabbed(false, getTarget));
    expect(document.activeElement?.id).toBe("tab-open");
  });

  it("reads the latest getter, not the first one", () => {
    const view = render(renderTabbed(true, () => null));
    byText("row").focus();
    click("arm");
    const latest = () => document.getElementById("tab-open");
    view.rerender(renderTabbed(true, latest));
    view.rerender(renderTabbed(false, latest));
    expect(document.activeElement?.id).toBe("tab-open");
  });

  it("falls back to the main content when the target is gone", () => {
    const view = render(renderTabbed(true, () => null));
    byText("row").focus();
    click("arm");
    view.rerender(renderTabbed(false, () => null));
    expect(document.activeElement?.id).toBe("main-content");
  });
});

describe("enclosingTab (#858)", () => {
  it("is the tab labelling the element's tab panel, else null", () => {
    render(renderTabbed(true));
    expect(enclosingTab(byText("row"))?.id).toBe("tab-open");
    expect(enclosingTab(byText("Open"))).toBeNull();
    expect(enclosingTab(null)).toBeNull();
  });
});

// wiki-v2 #913 (dialog race): the check can run while focus is still on the closing confirm dialog's button.
// Mantine returns focus about 10 ms after close (often to an already-detached menu item, a no-op) and unmounts
// the dialog only after its ~200 ms exit transition, so the hook (or the row that owns it) is gone by the time
// focus falls to <body>. jsdom has no transitions: the test keeps a dialog in the DOM, outside React, and
// removes it by hand.
function openClosingDialog(): HTMLElement {
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("data-closing-dialog", "");
  const confirm = document.createElement("button");
  confirm.textContent = "Confirm";
  dialog.append(confirm);
  document.body.append(dialog);
  confirm.focus();
  return dialog;
}

describe("useFocusFallback while a dialog is closing (#913)", () => {
  it("a row that unmounted while focus was in the dialog: focus moves to main once the dialog leaves", async () => {
    const view = renderInMain(<Host showRow />);
    const dialog = openClosingDialog();
    click("arm");
    view.rerender(
      <main id="main-content" tabIndex={-1}>
        <Host showRow={false} />
      </main>,
    );
    // Still on the dialog's button: nothing to restore yet, and nothing moved.
    expect(document.activeElement).toBe(byText("Confirm"));
    dialog.remove();
    await waitFor(() =>
      expect(document.activeElement?.id).toBe("main-content"),
    );
  });

  it("a list commit while focus was in the dialog: focus moves to main once the dialog leaves", async () => {
    renderInMain(<List />);
    const dialog = openClosingDialog();
    click("arm");
    click("remove");
    expect(document.activeElement).toBe(byText("Confirm"));
    dialog.remove();
    await waitFor(() =>
      expect(document.activeElement?.id).toBe("main-content"),
    );
  });

  it("uses the caller's target after the row unmounted", async () => {
    const tab = () => document.getElementById("tab-open");
    const view = render(renderTabbed(true, tab));
    const dialog = openClosingDialog();
    click("arm");
    view.rerender(renderTabbed(false, tab));
    dialog.remove();
    await waitFor(() => expect(document.activeElement?.id).toBe("tab-open"));
  });

  it("focus that leaves the dialog for a live element is kept", async () => {
    const view = renderInMain(
      <>
        <Host showRow />
        <button>survivor</button>
      </>,
    );
    const dialog = openClosingDialog();
    click("arm");
    view.rerender(
      <main id="main-content" tabIndex={-1}>
        <Host showRow={false} />
        <button>survivor</button>
      </main>,
    );
    byText("survivor").focus(); // Mantine's return reached a trigger that survived
    dialog.remove();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(byText("survivor"));
  });

  it(`gives up after ${FOCUS_FALLBACK_DIALOG_WAIT_MS} ms: a dialog that stays is not closing`, async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const view = renderInMain(<Host showRow />);
    const dialog = openClosingDialog();
    click("arm");
    view.rerender(
      <main id="main-content" tabIndex={-1}>
        <Host showRow={false} />
      </main>,
    );
    vi.advanceTimersByTime(FOCUS_FALLBACK_DIALOG_WAIT_MS + 1);
    dialog.remove();
    await Promise.resolve();
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(document.body);
  });
});
