import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

// CCC (wiki-v2 #797, INV-6): a restricted page takes per-person grants only. The picker on the
// page-permission tab never offers groups, and a grandfathered group grant row offers only its
// current role or lower (the server refuses raising it, and refuses every new group grant).

const searchArgs = vi.hoisted(() => ({
  last: undefined as unknown,
  // ONE stable answer: the component re-derives its options in an effect keyed on it.
  answer: {
    data: {
      users: [{ id: "u1", name: "Alice", email: "alice@example.edu", avatarUrl: null }],
      groups: [{ id: "g1", name: "Team" }],
    },
    isLoading: false,
  },
}));
vi.mock("@/features/search/queries/search-query.ts", () => ({
  useSearchSuggestionsQuery: (args: unknown) => {
    searchArgs.last = args;
    return searchArgs.answer;
  },
}));
vi.mock("@/features/user/atoms/current-user-atom", async () => {
  const { atom } = await import("jotai");
  return { userAtom: atom({ id: "me" }) };
});
const i18n = vi.hoisted(() => ({ t: (k: string) => k })); // stable, like the real hook's `t`
vi.mock("react-i18next", () => ({ useTranslation: () => i18n }));

import { MultiMemberSelect } from "@/features/space/components/multi-member-select";
import { PagePermissionItem } from "./page-permission-item";

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
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
  }
  Element.prototype.scrollIntoView ??= () => {};
});

afterEach(cleanup);

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>);

describe("MultiMemberSelect includeGroups (#797)", () => {
  it("includeGroups={false}: asks for no groups and lists none, only people", () => {
    wrap(<MultiMemberSelect onChange={() => {}} includeGroups={false} />);
    expect(searchArgs.last).toMatchObject({ includeUsers: true, includeGroups: false });
    const input = screen.getByPlaceholderText("Search for users");
    fireEvent.click(input);
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.queryByText("Team")).toBeNull();
  });

  it("default: groups are offered (space member adds are unchanged)", () => {
    wrap(<MultiMemberSelect onChange={() => {}} />);
    expect(searchArgs.last).toMatchObject({ includeGroups: true });
    fireEvent.click(screen.getByPlaceholderText("Search for users and groups"));
    expect(screen.getByText("Team")).toBeTruthy();
  });
});

describe("PagePermissionItem role menu (#797, INV-6)", () => {
  const open = (member: Record<string, unknown>) => {
    wrap(
      <PagePermissionItem
        member={{ name: "X", memberCount: 3, ...member } as never}
        onRoleChange={() => {}}
        onRemove={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Can (view|edit)/ }));
  };
  const options = async () =>
    (await screen.findAllByRole("menuitem")).map((el) => el.textContent ?? "");

  it("a group reader grant offers only Can view (never a raise)", async () => {
    open({ id: "g1", type: "group", role: "reader" });
    const labels = await options();
    expect(labels.some((l) => l.includes("Can view"))).toBe(true);
    expect(labels.some((l) => l.includes("Can edit"))).toBe(false);
  });

  it("a group writer grant may be kept or lowered", async () => {
    open({ id: "g1", type: "group", role: "writer" });
    const labels = await options();
    expect(labels.some((l) => l.includes("Can edit"))).toBe(true);
    expect(labels.some((l) => l.includes("Can view"))).toBe(true);
  });

  it("a person's grant keeps both roles", async () => {
    open({ id: "u2", type: "user", role: "reader", email: "b@example.edu" });
    expect((await options()).some((l) => l.includes("Can edit"))).toBe(true);
  });
});
