// Fork-owned (issue #406): keep posthog-js off the eager import graph.
//
// posthog-js is downloaded/evaluated only on a cloud deployment with telemetry configured (isCloud() &&
// isPostHogEnabled()); a self-hosted visitor never pays for it. Upstream imported posthog-js + PostHogProvider
// statically in main.tsx and rendered PosthogUser from an eager layout import, so ~209 KB (~48 KB brotli) sat
// on every visitor's first paint. This module owns the two dynamic seams that replace those eager paths.
import { Suspense, useEffect, type ReactNode } from "react";
import { isCloud, isPostHogEnabled } from "@/lib/config.ts";
import { lazyWithReload } from "@/features/layout/lazy-with-reload.ts";

// Children render immediately and unconditionally — the wrapped subtree's element type never changes, so
// <App/> is never remounted. In cloud, posthog is initialized from a dynamically-imported chunk in an effect
// (best-effort: telemetry must never break the app or block first paint). No PostHogProvider is needed:
// usePostHog() falls back to the global posthog singleton that initPostHog() initializes, and PosthogUser (the
// sole consumer) reads it with optional chaining.
export function PostHogAnalytics({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (!(isCloud() && isPostHogEnabled())) return;
    void import("./posthog-init.ts")
      .then(({ initPostHog }) => initPostHog())
      .catch(() => {});
  }, []);
  return <>{children}</>;
}

// Cloud-only identify/group side effects. The global layout renders this behind `isCloud()`; loading it lazily
// keeps posthog-js (which posthog-user.tsx imports for usePostHog) off the eager graph. The component is
// headless, so a null Suspense fallback is invisible.
const LazyPosthogUser = lazyWithReload(() =>
  import("@/ee/components/posthog-user.tsx").then((m) => ({
    default: m.PosthogUser,
  })),
);

export function PosthogUser() {
  return (
    <Suspense fallback={null}>
      <LazyPosthogUser />
    </Suspense>
  );
}
