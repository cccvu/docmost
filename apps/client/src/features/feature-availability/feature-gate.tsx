import React from "react";
import { useHasFeature } from "@/ee/hooks/use-feature";

// CCC feature-availability gate (issue: UI consistency).
//
// This is an internal, self-hosted deployment with no paid/enterprise entitlements,
// so Docmost's licensed features are NEVER available. Upstream renders those
// controls DISABLED with an "Available with a paid license" tooltip — noise that
// advertises things nobody can buy or use here. The rule for CCC surfaces is HIDE,
// not disable: unavailable functionality simply isn't rendered.
//
// `useFeatureAvailable` is the single predicate (a thin, intention-revealing wrapper
// over the upstream entitlement check); `<FeatureGate>` is the declarative form.
// Prefer these over hand-rolling `disabled={!hasFeature}` + upgrade tooltips.

/** True iff `feature` is available in this deployment (entitled). */
export function useFeatureAvailable(feature: string): boolean {
  return useHasFeature(feature);
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
