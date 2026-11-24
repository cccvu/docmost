// CCC (fork-owned test, wiki-v2 #858 + #913). A comment thread can be resolved and re-opened from the SPA: the
// fork serves POST /api/comments/resolve in both modes, so the never-granted `comment:resolution` licence
// entitlement no longer hides the action. And deleting a comment through its confirm dialog puts keyboard
// focus back on the comment tab instead of dropping it on <body> when the comment unmounts. The actions are
// reachable by keyboard: transparent at rest rather than hidden, and shown while they hold focus.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider, Tabs } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import {
  InfiniteData,
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { createStore, Provider } from "jotai";

const postMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({
  default: { post: (...a: unknown[]) => postMock(...a) },
}));
vi.mock("@mantine/notifications", () => ({
  notifications: { show: vi.fn() },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "en-US" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
// No entitlement is ever granted in this build (the real hook reads an empty entitlement atom).
vi.mock("@/ee/hooks/use-feature", () => ({ useHasFeature: () => false }));
// The read-only comment body is a full Tiptap editor; it is not what this test is about.
vi.mock("@/features/comment/components/comment-editor", () => ({
  default: () => <div data-testid="comment-body" />,
}));
vi.mock("@docmost/editor-ext", () => ({ isEditorReady: () => false }));

import CommentListItem from "./comment-list-item";
import { RQ_KEY } from "@/features/comment/queries/comment-query";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom.ts";
import { IComment } from "@/features/comment/types/comment.types";
import { IPagination } from "@/lib/types.ts";

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

const COMMENT = {
  id: "c-1",
  content: "{}",
  creatorId: "u-1",
  pageId: "page-1",
  workspaceId: "w-1",
  createdAt: new Date("2026-11-01T10:00:00Z"),
  creator: { id: "u-1", name: "Ada" },
} as unknown as IComment;

type Cache = InfiniteData<IPagination<IComment>>;

// The comments the list shows come from the same cache the delete and resolve mutations update.
function List() {
  const { data } = useQuery<Cache>({
    queryKey: RQ_KEY("page-1"),
    queryFn: () => new Promise<Cache>(() => {}),
    enabled: false,
  });
  const items = data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      {items.map((c) => (
        <CommentListItem
          key={c.id}
          comment={c}
          pageId="page-1"
          canComment={true}
        />
      ))}
    </>
  );
}

function renderItem() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData<Cache>(RQ_KEY("page-1"), {
    pages: [{ items: [COMMENT], meta: {} as IPagination<IComment>["meta"] }],
    pageParams: [undefined],
  });
  const store = createStore();
  store.set(currentUserAtom, {
    user: { id: "u-1", name: "Ada" },
    workspace: { id: "w-1" },
  } as never);
  render(
    <QueryClientProvider client={client}>
      <Provider store={store}>
        <MantineProvider env="test">
          <ModalsProvider>
            <Tabs defaultValue="open">
              <Tabs.List>
                <Tabs.Tab value="open">Open</Tabs.Tab>
              </Tabs.List>
              <Tabs.Panel value="open">
                <List />
              </Tabs.Panel>
            </Tabs>
          </ModalsProvider>
        </MantineProvider>
      </Provider>
    </QueryClientProvider>,
  );
  return client;
}

/** The item's actions show on hover only. */
function hover() {
  for (
    let el: HTMLElement | null = screen.getByTestId("comment-body");
    el;
    el = el.parentElement
  ) {
    fireEvent.mouseEnter(el);
  }
}

function openMenu() {
  hover();
  const trigger = screen.getByRole("button", { name: "Comment menu" });
  trigger.focus();
  fireEvent.click(trigger);
  return trigger;
}

beforeEach(() => {
  postMock.mockReset();
  localStorage.clear();
});

describe("CommentListItem resolve (#858)", () => {
  it("offers Resolve on a thread's first comment and calls /comments/resolve", async () => {
    postMock.mockImplementation(async (url: string) => {
      if (url === "/comments/resolve") {
        return { data: { ...COMMENT, resolvedAt: new Date(), resolvedById: "u-1" } };
      }
      throw new Error(`unexpected POST ${url}`);
    });
    renderItem();
    openMenu();

    fireEvent.click(await screen.findByRole("menuitem", { name: "Resolve comment" }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/comments/resolve", {
        commentId: "c-1",
        pageId: "page-1",
        resolved: true,
      }),
    );
  });
});

describe("CommentListItem hover resolve (#858)", () => {
  it("shows a named Resolve button on hover and calls /comments/resolve", async () => {
    postMock.mockImplementation(async (url: string) => {
      if (url === "/comments/resolve") {
        return { data: { ...COMMENT, resolvedAt: new Date(), resolvedById: "u-1" } };
      }
      throw new Error(`unexpected POST ${url}`);
    });
    renderItem();
    hover();

    fireEvent.click(screen.getByRole("button", { name: "Resolve comment" }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/comments/resolve", {
        commentId: "c-1",
        pageId: "page-1",
        resolved: true,
      }),
    );
  });
});

describe("CommentListItem keyboard actions (#913)", () => {
  it("keeps the actions reachable without a pointer and shows them while they hold focus", () => {
    renderItem();
    // No hover: the actions are transparent, never `visibility: hidden` (which takes them out of the Tab order
    // and the accessibility tree, so a keyboard user could not resolve or delete).
    const trigger = screen.getByRole("button", { name: "Comment menu" });
    const actions = trigger.closest("div[style]") as HTMLElement;
    expect(actions.style.visibility).toBe("");
    expect(actions.style.opacity).toBe("0");
    act(() => trigger.focus());
    expect(actions.style.opacity).toBe("1");
    act(() => trigger.blur());
    expect(actions.style.opacity).toBe("0");
  });
});

describe("CommentListItem delete focus (#913)", () => {
  it("puts focus on the comment tab once the deleted comment and its dialog are gone", async () => {
    postMock.mockImplementation(async (url: string) => {
      if (url === "/comments/delete") return {};
      throw new Error(`unexpected POST ${url}`);
    });
    renderItem();
    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete comment" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/comments/delete", {
        commentId: "c-1",
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("comment-body")).toBeNull());
    // The confirm dialog finishes its exit transition; then nothing else holds focus.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), {
      timeout: 2000,
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Open" })),
    );
    await act(async () => {});
  });
});
