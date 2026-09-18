// CCC (issue #309): route-level code splitting for rarely-visited pages.
//
// Fork-owned on purpose: `App.tsx` is an upstream file (UPSTREAM_MODIFICATIONS.md #6, "modify
// minimally"), so the lazy definitions live here and App.tsx only swaps import lines and adds one
// <Suspense> around <Routes>. Each export is a React.lazy component whose chunk is fetched the
// first time its route renders, keeping settings/EE/share/auth-edge screens out of the entry bundle.
//
// Page / Home / login / Layout (and the other primary cold-load-path routes) stay EAGER on purpose:
// the page view is the primary cold-load path, and an extra round trip there would cost more than
// it saves. See lazy-pages.test.ts for the pinned set.
import { createElement, lazy, Suspense, type ComponentProps } from "react";
// Type-only: erased at build time, so this does NOT put src/ee/base on the eager graph.
import type { BaseView as BaseViewImpl } from "@/ee/base/components/base-view";

// ---- auth / onboarding edges ------------------------------------------------------------------
export const SetupWorkspace = lazy(() => import("@/pages/auth/setup-workspace.tsx"));
export const InviteSignup = lazy(() => import("@/pages/auth/invite-signup.tsx"));
export const MfaChallengePage = lazy(() =>
  import("@/ee/mfa/pages/mfa-challenge-page").then((m) => ({
    default: m.MfaChallengePage,
  })),
);
export const MfaSetupRequiredPage = lazy(() =>
  import("@/ee/mfa/pages/mfa-setup-required-page").then((m) => ({
    default: m.MfaSetupRequiredPage,
  })),
);
export const CreateWorkspace = lazy(() => import("@/ee/pages/create-workspace.tsx"));
export const CloudLogin = lazy(() => import("@/ee/pages/cloud-login.tsx"));
export const VerifyEmail = lazy(() => import("@/ee/pages/verify-email.tsx"));

// ---- public share + pdf render ----------------------------------------------------------------
export const ShareLayout = lazy(
  () => import("@/features/share/components/share-layout.tsx"),
);
export const SharedPage = lazy(() => import("@/pages/share/shared-page.tsx"));
export const ShareRedirect = lazy(() => import("@/pages/share/share-redirect.tsx"));
export const PdfRenderPage = lazy(() => import("@/ee/pdf-export/pdf-render-page.tsx"));

// ---- in-app, behind <Layout/>, but off the page-view path -------------------------------------
export const AiChat = lazy(() => import("@/ee/ai-chat/pages/ai-chat.tsx"));
export const TemplateList = lazy(() => import("@/ee/template/pages/template-list"));
export const TemplateEditor = lazy(() => import("@/ee/template/pages/template-editor"));
export const SpaceTrash = lazy(() => import("@/pages/space/space-trash.tsx"));
export const BasePage = lazy(() => import("@/ee/base/pages/base-page.tsx"));

// ---- settings ---------------------------------------------------------------------------------
export const AccountSettings = lazy(
  () => import("@/pages/settings/account/account-settings"),
);
export const AccountPreferences = lazy(
  () => import("@/pages/settings/account/account-preferences.tsx"),
);
export const UserApiKeys = lazy(() => import("@/ee/api-key/pages/user-api-keys"));
export const WorkspaceSettings = lazy(
  () => import("@/pages/settings/workspace/workspace-settings"),
);
export const WorkspaceMembers = lazy(
  () => import("@/pages/settings/workspace/workspace-members"),
);
export const WorkspaceApiKeys = lazy(
  () => import("@/ee/api-key/pages/workspace-api-keys"),
);
export const Groups = lazy(() => import("@/pages/settings/group/groups"));
// App.tsx imported this one relatively ("./pages/settings/group/group-info"); same module.
export const GroupInfo = lazy(() => import("@/pages/settings/group/group-info"));
export const Spaces = lazy(() => import("@/pages/settings/space/spaces.tsx"));
export const Shares = lazy(() => import("@/pages/settings/shares/shares.tsx"));
export const Security = lazy(() => import("@/ee/security/pages/security.tsx"));
export const AiSettings = lazy(() => import("@/ee/ai/pages/ai-settings.tsx"));
export const AuditLogs = lazy(() => import("@/ee/audit/pages/audit-logs.tsx"));
export const VerifiedPages = lazy(
  () => import("@/ee/page-verification/pages/verified-pages.tsx"),
);
export const License = lazy(() => import("@/ee/licence/pages/license.tsx"));
export const Billing = lazy(() => import("@/ee/billing/pages/billing.tsx"));

// ---- non-route lazy wrappers ------------------------------------------------------------------
// page.tsx renders BaseView directly (outside <Routes>, so App's <Suspense> does not cover it) and the
// Bases grid (@tanstack/react-table + src/ee/base) is hidden in this deployment (seam #70). A plain
// component wrapping lazy() in its own <Suspense> keeps the call site a one-line import swap.
type BaseViewProps = ComponentProps<typeof BaseViewImpl>;
const LazyBaseView = lazy(() =>
  import("@/ee/base/components/base-view").then((m) => ({ default: m.BaseView })),
);
export const BaseView = function BaseViewLazy(props: BaseViewProps) {
  return createElement(
    Suspense,
    { fallback: null },
    createElement(LazyBaseView, props),
  );
};
