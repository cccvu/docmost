// CCC (fork-owned test, wiki-v2 #858): the share-for-page read answers `null`, never `undefined`, for a page
// with no share. The server's response envelope drops `data` when the value is undefined, and TanStack Query v5
// refuses `undefined` from a queryFn ("Query data cannot be undefined"), so every page view logged the error and
// left the query in its error state.
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const postMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({
  default: { post: (...a: unknown[]) => postMock(...a) },
}));
vi.mock("@mantine/notifications", () => ({
  notifications: { show: vi.fn() },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { getShareForPage } from "@/features/share/services/share-service";
import { useShareForPageQuery } from "./share-query";

const SHARE = { id: "share-1", key: "k1", level: 0, pageId: "page-1" };

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => postMock.mockReset());

describe("getShareForPage (#858)", () => {
  it("answers null when the server body carries no data (no share)", async () => {
    // What the api client hands back for `{data: undefined, success, status}` after JSON drops `data`.
    postMock.mockResolvedValue({ success: true, status: 200 });
    await expect(getShareForPage("page-1")).resolves.toBeNull();
    expect(postMock).toHaveBeenCalledWith("/shares/for-page", {
      pageId: "page-1",
    });
  });

  it("answers the share when there is one", async () => {
    postMock.mockResolvedValue({ data: SHARE, success: true, status: 200 });
    await expect(getShareForPage("page-1")).resolves.toEqual(SHARE);
  });
});

describe("useShareForPageQuery (#858)", () => {
  it("succeeds with null for an unshared page (not an error state)", async () => {
    postMock.mockResolvedValue({ success: true, status: 200 });
    const { result } = renderHook(() => useShareForPageQuery("page-1"), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isFetched).toBe(true));
    expect(result.current.isSuccess).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.data).toBeNull();
  });
});
