// CCC (fork-owned test, wiki-v2 #858): in remote mode the platform owns the display name and re-asserts it
// on every sign-in, so a wiki-side rename is silently undone. The Profile name is read-only there (focusable,
// with a reason, no Save); native mode keeps upstream's editable form.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { createStore, Provider } from "jotai";

const nativeState = vi.hoisted(() => ({ value: false }));
vi.mock("@/features/auth-native/lib/auth-mode.ts", () => ({
  isNativeAuthEnabled: () => nativeState.value,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
const updateUserMock = vi.hoisted(() => vi.fn());
vi.mock("@/features/user/services/user-service.ts", () => ({
  updateUser: (...a: unknown[]) => updateUserMock(...a),
}));
vi.mock("@mantine/notifications", () => ({
  notifications: { show: vi.fn() },
}));

import { currentUserAtom } from "@/features/user/atoms/current-user-atom.ts";
import AccountNameForm from "./account-name-form";

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
});

const REASON = "Your name is managed by your organization account";

function renderForm() {
  const store = createStore();
  store.set(currentUserAtom, {
    user: { id: "u1", name: "Ada Lovelace" },
    workspace: { id: "w1" },
  } as never);
  return render(
    <Provider store={store}>
      <MantineProvider env="test">
        <AccountNameForm />
      </MantineProvider>
    </Provider>,
  );
}

beforeEach(() => {
  nativeState.value = false;
  updateUserMock.mockReset();
  localStorage.clear();
});

describe("AccountNameForm (#858)", () => {
  it("remote: shows the name read-only (not disabled) with the reason and no Save", () => {
    renderForm();
    const input = screen.getByRole("textbox", { name: "Name" });
    expect((input as HTMLInputElement).value).toBe("Ada Lovelace");
    expect(input.hasAttribute("readonly")).toBe(true);
    expect(input.hasAttribute("disabled")).toBe(false);
    expect(screen.getByText(REASON)).toBeTruthy();
    // The reason is the input's description, so a screen reader announces it with the field.
    const describedBy = input.getAttribute("aria-describedby") ?? "";
    expect(describedBy).not.toBe("");
    expect(document.getElementById(describedBy)?.textContent).toBe(REASON);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("remote: Enter in the field writes nothing", () => {
    renderForm();
    const input = screen.getByRole("textbox", { name: "Name" });
    fireEvent.submit(input.closest("form") ?? input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("native: keeps the editable field and Save", async () => {
    nativeState.value = true;
    updateUserMock.mockResolvedValue({ id: "u1", name: "Ada King" });
    renderForm();
    const input = screen.getByRole("textbox", { name: "Name" });
    expect(input.hasAttribute("readonly")).toBe(false);
    expect(screen.queryByText(REASON)).toBeNull();
    fireEvent.change(input, { target: { value: "Ada King" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() =>
      expect(updateUserMock).toHaveBeenCalledWith({ name: "Ada King" }),
    );
  });
});
