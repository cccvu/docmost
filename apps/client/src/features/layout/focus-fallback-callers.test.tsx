// wiki-v2 #913 — NOT upstream Docmost code. The three confirm openers that arm the focus fallback
// (use-focus-fallback.ts) but have no test of their own: the page delete and restore modals, and the share
// row's delete. Each confirm removes the focused trigger; focus must land on the main content, never <body>.
// The hook itself is covered by use-focus-fallback.test.tsx; this pins that each caller arms it.
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import React, { useEffect, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter } from "react-router-dom";

// The confirm modal itself is Mantine's; capture its options and confirm directly.
const modal = vi.hoisted(() => ({
  onConfirm: undefined as undefined | (() => void),
}));
vi.mock("@mantine/modals", () => ({
  modals: {
    openConfirmModal: (opts: { onConfirm?: () => void }) => {
      modal.onConfirm = opts.onConfirm;
    },
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

const share = vi.hoisted(() => ({ remove: () => {} }));
vi.mock("@/features/share/queries/share-query.ts", () => ({
  useDeleteShareMutation: () => ({
    mutateAsync: async () => {
      share.remove();
    },
  }),
}));
vi.mock("@/hooks/use-clipboard", () => ({
  useClipboard: () => ({ copy: () => {} }),
}));

import { useDeletePageModal } from "@/features/page/hooks/use-delete-page-modal";
import { useRestorePageModal } from "@/features/page/hooks/use-restore-page-modal";
import ShareActionMenu from "@/features/share/components/share-action-menu";

beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
  if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

beforeEach(() => {
  modal.onConfirm = undefined;
});
afterEach(cleanup);

/** A list whose row (the trigger) the confirm removes; the opener hook lives in the list, as in the app. */
function OpenerList({ kind }: { kind: "delete" | "restore" }) {
  const [present, setPresent] = useState(true);
  const { openDeleteModal } = useDeletePageModal();
  const { openRestoreModal } = useRestorePageModal();
  const open = () =>
    kind === "delete"
      ? openDeleteModal({ onConfirm: () => setPresent(false) })
      : openRestoreModal({
          title: "Old page",
          onConfirm: () => setPresent(false),
        });
  return present ? <button onClick={open}>Row action</button> : <p>empty</p>;
}

function ShareRow() {
  const [present, setPresent] = useState(true);
  useEffect(() => {
    share.remove = () => setPresent(false);
  }, []);
  return present ? (
    <ShareActionMenu
      share={
        {
          key: "k1",
          page: { slugId: "s1", title: "Shared page" },
          space: { slug: "eng", userRole: "writer" },
        } as never
      }
    />
  ) : (
    <p>empty</p>
  );
}

function renderInMain(node: React.ReactNode) {
  render(
    <MantineProvider env="test">
      <MemoryRouter>
        <main id="main-content" tabIndex={-1}>
          {node}
        </main>
      </MemoryRouter>
    </MantineProvider>,
  );
}

describe("focus after a confirmed removal: the openers arm the fallback (#913)", () => {
  it.each([
    ["page delete modal", "delete"],
    ["page restore modal", "restore"],
  ] as const)(
    "%s: the row goes, focus is on the main content",
    async (_l, kind) => {
      renderInMain(<OpenerList kind={kind} />);
      const trigger = screen.getByRole("button", { name: "Row action" });
      trigger.focus();
      fireEvent.click(trigger);
      expect(modal.onConfirm).toBeTypeOf("function");

      await act(async () => modal.onConfirm!());

      expect(screen.queryByRole("button", { name: "Row action" })).toBeNull();
      expect(document.activeElement).toBe(
        document.getElementById("main-content"),
      );
    },
  );

  it("share row delete: the row unmounts, focus is on the main content", async () => {
    renderInMain(<ShareRow />);
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Delete share" }),
    );
    expect(modal.onConfirm).toBeTypeOf("function");
    screen.getByRole("button", { name: "More options" }).focus();

    await act(async () => modal.onConfirm!());

    expect(screen.queryByRole("button", { name: "More options" })).toBeNull();
    expect(document.activeElement).toBe(
      document.getElementById("main-content"),
    );
  });
});
