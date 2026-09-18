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
// Chunk-load failures reload the document once (see lazy-with-reload.ts).
import { createElement, Suspense, type ComponentProps } from "react";
import { lazyWithReload } from "./lazy-with-reload";
// Type-only: erased at build time, so this does NOT put src/ee/base on the eager graph.
import type { BaseView as BaseViewImpl } from "@/ee/base/components/base-view";

// ---- auth / onboarding edges ------------------------------------------------------------------
export const SetupWorkspace = lazyWithReload(() => import("@/pages/auth/setup-workspace.tsx"));
export const InviteSignup = lazyWithReload(() => import("@/pages/auth/invite-signup.tsx"));
export const MfaChallengePage = lazyWithReload(() =>
  import("@/ee/mfa/pages/mfa-challenge-page").then((m) => ({
    default: m.MfaChallengePage,
  })),
);
export const MfaSetupRequiredPage = lazyWithReload(() =>
  import("@/ee/mfa/pages/mfa-setup-required-page").then((m) => ({
    default: m.MfaSetupRequiredPage,
  })),
);
export const CreateWorkspace = lazyWithReload(() => import("@/ee/pages/create-workspace.tsx"));
export const CloudLogin = lazyWithReload(() => import("@/ee/pages/cloud-login.tsx"));
export const VerifyEmail = lazyWithReload(() => import("@/ee/pages/verify-email.tsx"));

// ---- public share + pdf render ----------------------------------------------------------------
export const ShareLayout = lazyWithReload(
  () => import("@/features/share/components/share-layout.tsx"),
);
export const SharedPage = lazyWithReload(() => import("@/pages/share/shared-page.tsx"));
export const ShareRedirect = lazyWithReload(() => import("@/pages/share/share-redirect.tsx"));
export const PdfRenderPage = lazyWithReload(() => import("@/ee/pdf-export/pdf-render-page.tsx"));

// ---- in-app, behind <Layout/>, but off the page-view path -------------------------------------
export const AiChat = lazyWithReload(() => import("@/ee/ai-chat/pages/ai-chat.tsx"));
export const TemplateList = lazyWithReload(() => import("@/ee/template/pages/template-list"));
export const TemplateEditor = lazyWithReload(() => import("@/ee/template/pages/template-editor"));
export const SpaceTrash = lazyWithReload(() => import("@/pages/space/space-trash.tsx"));
export const BasePage = lazyWithReload(() => import("@/ee/base/pages/base-page.tsx"));

// ---- settings ---------------------------------------------------------------------------------
export const AccountSettings = lazyWithReload(
  () => import("@/pages/settings/account/account-settings"),
);
export const AccountPreferences = lazyWithReload(
  () => import("@/pages/settings/account/account-preferences.tsx"),
);
export const UserApiKeys = lazyWithReload(() => import("@/ee/api-key/pages/user-api-keys"));
export const WorkspaceSettings = lazyWithReload(
  () => import("@/pages/settings/workspace/workspace-settings"),
);
export const WorkspaceMembers = lazyWithReload(
  () => import("@/pages/settings/workspace/workspace-members"),
);
export const WorkspaceApiKeys = lazyWithReload(
  () => import("@/ee/api-key/pages/workspace-api-keys"),
);
export const Groups = lazyWithReload(() => import("@/pages/settings/group/groups"));
// App.tsx imported this one relatively ("./pages/settings/group/group-info"); same module.
export const GroupInfo = lazyWithReload(() => import("@/pages/settings/group/group-info"));
export const Spaces = lazyWithReload(() => import("@/pages/settings/space/spaces.tsx"));
export const Shares = lazyWithReload(() => import("@/pages/settings/shares/shares.tsx"));
export const Security = lazyWithReload(() => import("@/ee/security/pages/security.tsx"));
export const AiSettings = lazyWithReload(() => import("@/ee/ai/pages/ai-settings.tsx"));
export const AuditLogs = lazyWithReload(() => import("@/ee/audit/pages/audit-logs.tsx"));
export const VerifiedPages = lazyWithReload(
  () => import("@/ee/page-verification/pages/verified-pages.tsx"),
);
export const License = lazyWithReload(() => import("@/ee/licence/pages/license.tsx"));
export const Billing = lazyWithReload(() => import("@/ee/billing/pages/billing.tsx"));

// ---- non-route lazy wrappers ------------------------------------------------------------------
// page.tsx renders BaseView directly (outside <Routes>, so App's <Suspense> does not cover it) and the
// Bases grid (@tanstack/react-table + src/ee/base) is hidden in this deployment (seam #70). A plain
// component wrapping lazyWithReload() in its own <Suspense> keeps the call site a one-line import swap.
type BaseViewProps = ComponentProps<typeof BaseViewImpl>;
const LazyBaseView = lazyWithReload(() =>
  import("@/ee/base/components/base-view").then((m) => ({ default: m.BaseView })),
);
export const BaseView = function BaseViewLazy(props: BaseViewProps) {
  return createElement(
    Suspense,
    { fallback: null },
    createElement(LazyBaseView, props),
  );
};
