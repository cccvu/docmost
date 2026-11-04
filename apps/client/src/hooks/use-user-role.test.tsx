import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { ReactNode } from "react";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom.ts";
import { UserRole } from "@/lib/types.ts";

// The remote-mode role gate (the fix under test, wiki-v2 #636).
const nativeState = vi.hoisted(() => ({ value: false }));
vi.mock("@/features/auth-native/lib/auth-mode.ts", () => ({
  isNativeAuthEnabled: () => nativeState.value,
}));

import useUserRole from "./use-user-role";

function roleOf(role: UserRole) {
  const store = createStore();
  store.set(currentUserAtom, { user: { role } } as never);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  return renderHook(() => useUserRole(), { wrapper }).result.current;
}

describe("useUserRole", () => {
  beforeEach(() => {
    nativeState.value = false;
  });

  it("remote mode: an owner or admin session gets member flags (the server ignores users.role)", () => {
    for (const role of [UserRole.OWNER, UserRole.ADMIN, UserRole.MEMBER]) {
      expect(roleOf(role)).toEqual({
        isAdmin: false,
        isOwner: false,
        isMember: true,
      });
    }
  });

  it("native mode: the stored role decides, as upstream", () => {
    nativeState.value = true;
    expect(roleOf(UserRole.OWNER)).toEqual({
      isAdmin: true,
      isOwner: true,
      isMember: false,
    });
    expect(roleOf(UserRole.ADMIN)).toEqual({
      isAdmin: true,
      isOwner: false,
      isMember: false,
    });
    expect(roleOf(UserRole.MEMBER)).toEqual({
      isAdmin: false,
      isOwner: false,
      isMember: true,
    });
  });
});
