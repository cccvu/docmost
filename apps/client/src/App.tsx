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
  AiChat,
  AiSettings,
  AuditLogs,
  BasePage,
  Billing,
  CloudLogin,
  CreateWorkspace,
  GroupInfo,
  Groups,
  InviteSignup,
  License,
  MfaChallengePage,
  MfaSetupRequiredPage,
  PdfRenderPage,
  Security,
  SetupWorkspace,
  ShareLayout,
  ShareRedirect,
  SharedPage,
  Shares,
  SpaceTrash,
  Spaces,
  TemplateEditor,
  TemplateList,
  UserApiKeys,
  VerifiedPages,
  VerifyEmail,
  WorkspaceApiKeys,
  WorkspaceMembers,
  WorkspaceSettings,
} from "@/features/layout/lazy-pages";

export default function App() {
  const { t } = useTranslation();
  useRedirectToCloudSelect();
  useTrackOrigin();

  return (
    <Suspense fallback={null}>
      <Routes>
        <Route index element={<RootGate />} />
        {/* Mode-aware sign-in: native (standalone) → Docmost login; remote → platform passwordless. */}
        <Route
          path={"/login"}
          element={isNativeAuthEnabled() ? <NativeLogin /> : <PasswordlessLogin />}
        />
        {/* Magic-link landing page — explicit-click consume (no auto-submit); see the component. */}
        <Route path={"/login/verify"} element={<PasswordlessVerify />} />
        <Route path={"/request-access"} element={<RequestAccess />} />
        <Route path={"/invites/:invitationId"} element={<InviteSignup />} />
        <Route path={"/login/mfa"} element={<MfaChallengePage />} />
        <Route path={"/login/mfa/setup"} element={<MfaSetupRequiredPage />} />

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

        <Route path={"/pdf-render/:pageId"} element={<PdfRenderPage />} />
        <Route path={"/share/:shareId"} element={<ShareRedirect />} />
        <Route path={"/p/:pageSlug"} element={<PageRedirect />} />

        <Route element={<Layout />}>
          <Route path={"/home"} element={<Home />} />
          <Route path={"/ai"} element={<AiChat />} />
          <Route path={"/ai/chat/:chatId"} element={<AiChat />} />
          <Route path={"/spaces"} element={<SpacesPage />} />
          <Route path={"/favorites"} element={<FavoritesPage />} />
          <Route path={"/labels/:labelName"} element={<LabelPage />} />
          <Route path={"/templates"} element={<TemplateList />} />
          <Route
            path={"/templates/:templateId"}
            element={<TemplateEditor />}
          />
          <Route path={"/s/:spaceSlug"} element={<SpaceHome />} />
          <Route path={"/s/:spaceSlug/trash"} element={<SpaceTrash />} />
          <Route
            path={"/s/:spaceSlug/p/:pageSlug"}
            element={<Page />}
          />

          <Route path={"/base/:pageId"} element={<BasePage />} />

          <Route path={"/settings"}>
            <Route path={"account/profile"} element={<AccountSettings />} />
            <Route
              path={"account/preferences"}
              element={<AccountPreferences />}
            />
            <Route path={"account/api-keys"} element={<UserApiKeys />} />
            <Route path={"workspace"} element={<WorkspaceSettings />} />
            <Route path={"members"} element={<WorkspaceMembers />} />
            <Route path={"api-keys"} element={<WorkspaceApiKeys />} />
            <Route path={"groups"} element={<Groups />} />
            <Route path={"groups/:groupId"} element={<GroupInfo />} />
            <Route path={"spaces"} element={<Spaces />} />
            <Route path={"sharing"} element={<Shares />} />
            <Route path={"security"} element={<Security />} />
            <Route path={"ai"} element={<AiSettings />} />
            <Route path={"ai/mcp"} element={<AiSettings />} />
            <Route path={"audit"} element={<AuditLogs />} />
            <Route path={"verifications"} element={<VerifiedPages />} />
            {!isCloud() && <Route path={"license"} element={<License />} />}
            {isCloud() && <Route path={"billing"} element={<Billing />} />}
          </Route>
        </Route>

        <Route path="*" element={<Error404 />} />
      </Routes>
    </Suspense>
  );
}
