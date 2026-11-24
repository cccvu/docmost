// wiki-v2 UI cleanup, #858 C1: page-history "Restore" (desktop history-list.tsx and history-modal-mobile.tsx
// both read `canRestore` from this hook) is the page's own edit right, sourced exactly as pages/page/page.tsx
// does (`!deletedAt && permissions.canEdit`). That is the server's edit decision (validateCanEdit, and collab's
// read-only flag): a space writer is not offered Restore on a restricted page they cannot edit, and a page-only
// editor (a space reader with an edit grant on a restricted page) is. The space's own rules no longer matter:
// the mock still serves them so re-adding a space gate turns the reader row red.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const WRITER_RULES = [
  { action: "read", subject: "settings" },
  { action: "read", subject: "member" },
  { action: "manage", subject: "page" },
];
const READER_RULES = [
  { action: "read", subject: "settings" },
  { action: "read", subject: "member" },
  { action: "read", subject: "page" },
];

const state = vi.hoisted(() => ({
  rules: [] as unknown[],
  page: undefined as
    | { deletedAt?: string | null; permissions?: { canEdit: boolean } }
    | undefined,
  requestedPageId: undefined as string | undefined,
}));

vi.mock("@/features/space/queries/space-query", () => ({
  useSpaceQuery: () => ({
    data: { id: "sp1", membership: { permissions: state.rules } },
  }),
}));
vi.mock("@/features/page/queries/page-query", () => ({
  usePageQuery: ({ pageId }: { pageId?: string }) => {
    state.requestedPageId = pageId;
    return { data: state.page };
  },
}));
vi.mock("@/features/page-history/queries/page-history-query", () => ({
  usePageHistoryQuery: () => ({ data: undefined }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { useHistoryRestore } from "./use-history-restore";

beforeEach(() => {
  state.rules = [];
  state.page = undefined;
  state.requestedPageId = undefined;
});

function canRestore(): boolean {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter initialEntries={["/s/eng/p/roadmap-AbC123xyz"]}>
      <Routes>
        <Route path="/s/:spaceSlug/p/:pageSlug" element={<>{children}</>} />
      </Routes>
    </MemoryRouter>
  );
  const { result } = renderHook(() => useHistoryRestore(), { wrapper });
  return result.current.canRestore;
}

describe("useHistoryRestore — canRestore", () => {
  it("space writer on a page they can edit: Restore offered (reads the route's page)", () => {
    state.rules = WRITER_RULES;
    state.page = { deletedAt: null, permissions: { canEdit: true } };
    expect(canRestore()).toBe(true);
    // The same slug id pages/page/page.tsx queries, so the cached page is reused.
    expect(state.requestedPageId).toBe("AbC123xyz");
  });

  it("space writer on a restricted page they cannot edit: no Restore", () => {
    state.rules = WRITER_RULES;
    state.page = { deletedAt: null, permissions: { canEdit: false } };
    expect(canRestore()).toBe(false);
  });

  it("space writer on a trashed page: no Restore (page.tsx's canEdit excludes deleted pages)", () => {
    state.rules = WRITER_RULES;
    state.page = {
      deletedAt: "2026-11-01T00:00:00Z",
      permissions: { canEdit: true },
    };
    expect(canRestore()).toBe(false);
  });

  it("page not loaded yet: no Restore (fails closed)", () => {
    state.rules = WRITER_RULES;
    state.page = undefined;
    expect(canRestore()).toBe(false);
  });

  it("page-only editor (space reader, page canEdit): Restore offered (matches the server's edit decision)", () => {
    state.rules = READER_RULES;
    state.page = { deletedAt: null, permissions: { canEdit: true } };
    expect(canRestore()).toBe(true);
  });

  it("space reader without page canEdit: no Restore", () => {
    state.rules = READER_RULES;
    state.page = { deletedAt: null, permissions: { canEdit: false } };
    expect(canRestore()).toBe(false);
  });
});
