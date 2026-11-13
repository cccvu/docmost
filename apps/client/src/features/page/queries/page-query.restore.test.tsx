// wiki-v2 #556: a refused restore must say why. In remote mode the server refuses a restore that would take a page
// out of its restricted section (409, nothing restored) or that brings back a sub-page the person cannot edit (403
// restore_needs_edit); the toast shows the server's fixed sentence. A bare refusal keeps the generic text + status.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AxiosError, AxiosHeaders } from "axios";
import type { ReactNode } from "react";

const mocks = vi.hoisted(() => ({
  show: vi.fn(),
  restorePage: vi.fn(),
}));
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.show } }));
vi.mock("@/features/page/services/page-service", () => ({ restorePage: mocks.restorePage }));
vi.mock("@/main.tsx", () => ({ queryClient: { invalidateQueries: async () => {}, setQueryData: () => {} } }));
vi.mock("@/features/websocket/use-query-emit", () => ({ useQueryEmit: () => () => {} }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { useRestorePageMutation } from "./page-query";

const STRIP =
  "Restoring this page would take it out of its restricted section, so nothing was restored. Restore the page it was under first.";

function httpError(status: number, data: unknown): AxiosError {
  return new AxiosError("Request failed", "ERR_BAD_REQUEST", undefined, {}, {
    status,
    statusText: "",
    data,
    headers: AxiosHeaders.from({}),
    config: { headers: new AxiosHeaders() },
  });
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

async function restoreFailingWith(error: unknown) {
  mocks.restorePage.mockRejectedValueOnce(error);
  const { result } = renderHook(() => useRestorePageMutation(), { wrapper });
  await act(async () => {
    await result.current.mutateAsync("p1").catch(() => undefined);
  });
}

describe("useRestorePageMutation — a refused restore says why (#556)", () => {
  beforeEach(() => {
    mocks.show.mockClear();
    mocks.restorePage.mockReset();
  });
  afterEach(() => cleanup());

  it("the restricted-section 409 shows the server's sentence in a red toast", async () => {
    await restoreFailingWith(httpError(409, { message: STRIP, code: "ccc_page_restriction_strip" }));
    expect(mocks.show).toHaveBeenCalledTimes(1);
    expect(mocks.show).toHaveBeenCalledWith({ message: STRIP, color: "red" });
  });

  it("restore_needs_edit (403) shows its sentence too", async () => {
    const message = "restoring a page needs edit access to it and to every sub-page trashed with it; nothing was restored";
    await restoreFailingWith(httpError(403, { message, code: "restore_needs_edit" }));
    expect(mocks.show).toHaveBeenCalledWith({ message, color: "red" });
  });

  it("a bare 403 (no code) keeps the generic text with its status, never the raw server string", async () => {
    await restoreFailingWith(httpError(403, { message: "Forbidden", statusCode: 403 }));
    expect(mocks.show).toHaveBeenCalledWith({ message: "Failed to restore page (HTTP 403)", color: "red" });
  });

  it("a 503 keeps the generic text with its status", async () => {
    await restoreFailingWith(httpError(503, { message: "the resource is busy; retry shortly", code: "engine_busy" }));
    expect(mocks.show).toHaveBeenCalledWith({ message: "Failed to restore page (HTTP 503)", color: "red" });
  });
});
