import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter } from "react-router-dom";

/**
 * CCC #133 (ADR 0035): Docmost EE login (SSO/LDAP) is unsupported, so the invite page must never render
 * `<SsoLogin/>` — even when the workspace advertises an LDAP provider and enforces SSO. Each test starts
 * from the REAL `isEnterpriseLoginEnabled()` value; the anti-vacuity case flips the mocked flag to prove
 * the gate is what hides it.
 */

const enterpriseLogin = vi.hoisted(() => ({ value: false }));
vi.mock("@/features/auth-native/lib/enterprise-login.ts", () => ({
  isEnterpriseLoginEnabled: () => enterpriseLogin.value,
}));

const invite = vi.hoisted(() => ({ enforceSso: false }));
vi.mock("@/features/workspace/queries/workspace-query.ts", () => ({
  useGetInvitationQuery: () => ({
    data: {
      id: "inv-1",
      email: "invitee@example.com",
      enforceSso: invite.enforceSso,
    },
    isError: false,
  }),
  useWorkspacePublicDataQuery: () => ({
    data: {
      id: "ws-1",
      enforceSso: invite.enforceSso,
      authProviders: [{ id: "ldap-1", name: "LDAP", type: "ldap" }],
    },
    isLoading: false,
  }),
}));

vi.mock("@/ee/components/sso-login.tsx", () => ({
  default: () => <div data-testid="ee-sso-login" />,
}));
vi.mock("@/features/auth/hooks/use-auth", () => ({
  default: () => ({ invitationSignup: vi.fn(), isLoading: false }),
}));
vi.mock("@/features/auth/hooks/use-redirect-if-authenticated.ts", () => ({
  useRedirectIfAuthenticated: () => {},
}));
vi.mock("@/features/auth/components/auth-layout.tsx", () => ({
  AuthLayout: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { InviteSignUpForm } from "@/features/auth/components/invite-sign-up-form";

beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
});

beforeEach(async () => {
  const actual = await vi.importActual<
    typeof import("@/features/auth-native/lib/enterprise-login.ts")
  >("@/features/auth-native/lib/enterprise-login.ts");
  enterpriseLogin.value = actual.isEnterpriseLoginEnabled();
  invite.enforceSso = false;
});

function renderForm() {
  return render(
    <MantineProvider>
      <MemoryRouter initialEntries={["/invites/inv-1?token=t"]}>
        <InviteSignUpForm />
      </MemoryRouter>
    </MantineProvider>,
  );
}

describe("InviteSignUpForm — EE login is unreachable (#133)", () => {
  it.each([false, true])(
    "never renders the EE SSO/LDAP login (enforceSso=%s)",
    (enforceSso) => {
      invite.enforceSso = enforceSso;
      renderForm();
      expect(screen.getByText("Join the workspace")).toBeTruthy();
      expect(screen.queryByTestId("ee-sso-login")).toBeNull();
    },
  );

  it("keeps the password sign-up form when SSO is not enforced", () => {
    renderForm();
    expect(screen.getByRole("button", { name: "Sign Up" })).toBeTruthy();
  });

  it("anti-vacuity: the isEnterpriseLoginEnabled() gate is what hides it", () => {
    enterpriseLogin.value = true;
    renderForm();
    expect(screen.getByTestId("ee-sso-login")).toBeTruthy();
  });
});
