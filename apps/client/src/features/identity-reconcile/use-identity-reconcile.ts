import { useEffect, useRef } from "react";
import platformApi from "@/lib/platform-client";
import { isNativeAuthEnabled } from "@/features/auth-native/lib/auth-mode";
import type { ChunkReloadEnv } from "@/features/layout/lazy-with-reload";
import {
  createIdentityReconciler,
  type IdentityReconciler,
} from "./identity-reconcile";

/**
 * wiki-v2 #761: reconcile the wiki identity with the platform session on mount, whenever the tab becomes
 * visible, and on window focus (see identity-reconcile.ts). Active only in remote mode and only for a
 * signed-in user (`currentUserId` set). Native mode has no platform, so it does nothing there.
 */
export function useIdentityReconcile(
  currentUserId: string | undefined,
  reloadEnv?: ChunkReloadEnv,
): void {
  const userRef = useRef(currentUserId);
  const activeRef = useRef(false);
  const reconcilerRef = useRef<IdentityReconciler | null>(null);
  const active = Boolean(currentUserId) && !isNativeAuthEnabled();

  // Declared before the listener effect, so a trigger in the same commit already reads the new id.
  useEffect(() => {
    userRef.current = currentUserId;
  }, [currentUserId]);

  useEffect(() => {
    if (!active) return;
    // One reconciler per mounted hook, so its single in-flight slot also spans a StrictMode re-run.
    reconcilerRef.current ??= createIdentityReconciler({
      api: platformApi,
      currentUserId: () => (activeRef.current ? userRef.current : undefined),
      reloadEnv,
    });
    const reconciler = reconcilerRef.current;
    activeRef.current = true;
    const check = () => void reconciler.trigger();
    const onVisibility = () => {
      if (document.visibilityState === "visible") check();
    };
    check();
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      activeRef.current = false;
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active]);
}
