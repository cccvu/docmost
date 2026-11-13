import { Route, Routes } from "react-router-dom";
import RootGate from "@/features/public/components/root-gate.tsx";
import RequestAccess from "@/pages/public/request-access.tsx";
// CCC passwordless auth (issue #4): in remote/integrated mode the platform login is passwordless (magic
// link + OTP). The old Docmost password LoginPage is unrouted; sign-in is these CCC-owned pages instead.
import PasswordlessLogin from "@/pages/public/passwordless-login.tsx";
import PasswordlessVerify from "@/pages/public/passwordless-verify.tsx";
// CCC standalone mode: in native mode the SAME build shows Docmost's own login instead of passwordless.
// The server is the source of truth (NATIVE_AUTH_ENABLED capability); the client only reflects it.
import NativeLogin from "@/features/auth-native/pages/native-login.tsx";
import { isNativeAuthEnabled } from "@/features/auth-native/lib/auth-mode.ts";
import { isEnterpriseLoginEnabled } from "@/features/auth-native/lib/enterprise-login.ts";
import Home from "@/pages/dashboard/home";
import Page from "@/pages/page/page";
import { Error404 } from "@/components/ui/error-404.tsx";
import SpaceHome from "@/pages/space/space-home.tsx";
import PageRedirect from "@/pages/page/page-redirect.tsx";
import Layout from "@/components/layouts/global/layout.tsx";
import { isCloud } from "@/lib/config.ts";
import { useTranslation } from "react-i18next";
import { useRedirectToCloudSelect } from "@/ee/hooks/use-redirect-to-cloud-select.tsx";
import { useTrackOrigin } from "@/hooks/use-track-origin";
import SpacesPage from "@/pages/spaces/spaces.tsx";
import FavoritesPage from "@/pages/favorites/favorites-page";
import LabelPage from "@/pages/label/label-page";
// CCC #309: rarely-visited routes load on demand (fork-owned lazy-pages.ts)
import { Suspense } from "react";
import {
  AccountPreferences,
  AccountSettings,
  Billing,
  CloudLogin,
  CreateWorkspace,
  GroupInfo,
  Groups,
  InviteSignup,
  MfaChallengePage,
  MfaSetupRequiredPage,
  SetupWorkspace,
  ShareLayout,
  ShareRedirect,
  SharedPage,
  Shares,
  SpaceTrash,
  Spaces,
  VerifyEmail,
  WorkspaceMembers,
  WorkspaceSettings,
} from "@/features/layout/lazy-pages";

export default function App() {
  const { t } = useTranslation();
  useRedirectToCloudSelect();
  useTrackOrigin();
  // CCC (wiki-v2 UI cleanup): in remote mode the platform owns members, groups and invites (the
  // server refuses the native routes), so those screens are registered in native mode only. The
  // platform's own public pages (magic-link landing, request access) are registered in remote mode only.
  const nativeDirectory = isNativeAuthEnabled();

  return (
    <Suspense fallback={null}>
      <Routes>
        <Route index element={<RootGate />} />
        {/* Mode-aware sign-in: native (standalone) → Docmost login; remote → platform passwordless. */}
        <Route
          path={"/login"}
          element={isNativeAuthEnabled() ? <NativeLogin /> : <PasswordlessLogin />}
        />
        {/* Platform-only pages: native (standalone) mode has no platform, so they fall to Error404.
            The magic-link landing is an explicit-click consume (no auto-submit); see the component. */}
        {!nativeDirectory && (
          <>
            <Route path={"/login/verify"} element={<PasswordlessVerify />} />
            <Route path={"/request-access"} element={<RequestAccess />} />
          </>
        )}
        {nativeDirectory && (
          <Route path={"/invites/:invitationId"} element={<InviteSignup />} />
        )}
        {/* CCC seam (#133): EE MFA login is unsupported (ADR 0035). */}
        {isEnterpriseLoginEnabled() && (
          <>
            <Route path={"/login/mfa"} element={<MfaChallengePage />} />
            <Route
              path={"/login/mfa/setup"}
              element={<MfaSetupRequiredPage />}
            />
          </>
        )}

        {!isCloud() && (
          <Route path={"/setup/register"} element={<SetupWorkspace />} />
        )}

        {isCloud() && (
          <>
            <Route path={"/create"} element={<CreateWorkspace />} />
            <Route path={"/select"} element={<CloudLogin />} />
            <Route path={"/verify-email"} element={<VerifyEmail />} />
          </>
        )}

        <Route element={<ShareLayout />}>
          <Route
            path={"/share/:shareId/p/:pageSlug"}
            element={<SharedPage />}
          />
          <Route path={"/share/p/:pageSlug"} element={<SharedPage />} />
        </Route>

        {/* CCC (wiki-v2 UI cleanup): the EE routes (/pdf-render, /ai, /templates, /base and the EE
            /settings pages) are unregistered: never entitled in either mode (ADR 0035). */}
        <Route path={"/share/:shareId"} element={<ShareRedirect />} />
        <Route path={"/p/:pageSlug"} element={<PageRedirect />} />

        <Route element={<Layout />}>
          <Route path={"/home"} element={<Home />} />
          <Route path={"/spaces"} element={<SpacesPage />} />
          <Route path={"/favorites"} element={<FavoritesPage />} />
          <Route path={"/labels/:labelName"} element={<LabelPage />} />
          <Route path={"/s/:spaceSlug"} element={<SpaceHome />} />
          <Route path={"/s/:spaceSlug/trash"} element={<SpaceTrash />} />
          <Route
            path={"/s/:spaceSlug/p/:pageSlug"}
            element={<Page />}
          />

          <Route path={"/settings"}>
            <Route path={"account/profile"} element={<AccountSettings />} />
            <Route
              path={"account/preferences"}
              element={<AccountPreferences />}
            />
            <Route path={"workspace"} element={<WorkspaceSettings />} />
            {nativeDirectory && (
              <>
                <Route path={"members"} element={<WorkspaceMembers />} />
                <Route path={"groups"} element={<Groups />} />
                <Route path={"groups/:groupId"} element={<GroupInfo />} />
              </>
            )}
            <Route path={"spaces"} element={<Spaces />} />
            <Route path={"sharing"} element={<Shares />} />
            {isCloud() && <Route path={"billing"} element={<Billing />} />}
          </Route>
        </Route>

        <Route path="*" element={<Error404 />} />
      </Routes>
    </Suspense>
  );
}
