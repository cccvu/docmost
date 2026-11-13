// wiki-v2 UI cleanup: page-history "Restore" (desktop history-list.tsx and history-modal-mobile.tsx
// both read `canRestore` from this hook) needs space Manage Page AND the page's own canEdit, sourced
// exactly as pages/page/page.tsx does (`!deletedAt && permissions.canEdit`). A space writer is no
// longer offered Restore on a restricted page they cannot edit. Real CASL over the space rules.
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

  it("space reader, even with page canEdit: no Restore (space gate unchanged)", () => {
    state.rules = READER_RULES;
    state.page = { deletedAt: null, permissions: { canEdit: true } };
    expect(canRestore()).toBe(false);
  });
});
