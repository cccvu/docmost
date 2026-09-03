import React from "react";
import { useHasFeature } from "@/ee/hooks/use-feature";
import { Feature } from "@/ee/features";

// CCC feature-availability gate (issue: UI consistency).
//
// This is an internal, self-hosted deployment with no paid/enterprise entitlements,
// so Docmost's licensed features are NEVER available. Upstream renders those
// controls DISABLED with an "Available with a paid license" tooltip — noise that
// advertises things nobody can buy or use here. The rule for CCC surfaces is HIDE,
// not disable: unavailable functionality simply isn't rendered.
//
// `useFeatureAvailable` is the intention-revealing predicate (a thin wrapper over the
// upstream entitlement check) and `<FeatureGate>` is its declarative form; composite
// domain predicates like `useSpaceSecurityAvailable` live here too so a rule spanning
// several entitlements is defined once. A single inline `hasFeature`/`useHasFeature`
// check at a leaf is equivalent and fine; reach for these when the intent is "HIDE
// unavailable functionality" rather than hand-rolling `disabled={!hasFeature}` +
// upgrade tooltips, and ALWAYS for a multi-entitlement rule (calling the hooks
// unconditionally — never behind `||`/`&&` short-circuit — to keep hook order stable).

/** True iff `feature` is available in this deployment (entitled). */
export function useFeatureAvailable(feature: string): boolean {
  return useHasFeature(feature);
}

/**
 * True iff the space "Security" surface has anything to show — i.e. either paid space
 * control (public sharing or viewer comments) is available. Defined once here so the
 * parent tab-gate and the child panel agree on the rule. Both hooks are called
 * UNCONDITIONALLY (not `a || b` at a call site, which would short-circuit the second
 * hook and violate the Rules of Hooks if entitlements ever change between renders).
 */
export function useSpaceSecurityAvailable(): boolean {
  const hasSharingControls = useFeatureAvailable(Feature.SHARING_CONTROLS);
  const hasViewerComments = useFeatureAvailable(Feature.VIEWER_COMMENTS);
  return hasSharingControls || hasViewerComments;
}

/**
 * Render `children` only when `feature` is available; otherwise render `fallback`
 * (default: nothing). Use this to HIDE unavailable/paid functionality rather than
 * showing a disabled "upgrade" affordance.
 */
export function FeatureGate({
  feature,
  children,
  fallback = null,
}: {
  feature: string;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}): React.ReactElement | null {
  const available = useFeatureAvailable(feature);
  return <>{available ? children : fallback}</>;
}
