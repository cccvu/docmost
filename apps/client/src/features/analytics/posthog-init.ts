// Fork-owned (issue #406): the ONLY module that statically imports posthog-js. It is reached solely through a
// dynamic import() from posthog-analytics.tsx, and only when isCloud() && isPostHogEnabled(), so posthog-js
// never lands on the eager import graph — a self-hosted visitor never downloads or evaluates it. CLOUD is a
// runtime value (window.CONFIG), so this is necessarily a runtime dynamic import, not a build-time drop.
import posthog from "posthog-js";
import { getPostHogHost, getPostHogKey } from "@/lib/config.ts";

let initialized = false;

// Initialize the global posthog singleton once. Idempotent, so a re-run of the calling effect is a no-op.
export function initPostHog(): void {
  if (initialized) return;
  initialized = true;
  posthog.init(getPostHogKey(), {
    api_host: getPostHogHost(),
    defaults: "2025-05-24",
    disable_session_recording: true,
    capture_pageleave: false,
  });
}
