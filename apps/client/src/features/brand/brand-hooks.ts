import { useSyncExternalStore } from "react";
import { getBrandConfig, subscribeBrand, type BrandConfig } from "./brand-config";

/** Subscribe a component to the runtime brand bundle (loaded once at boot; see brand-config.ts). */
export function useBrandConfig(): BrandConfig {
  return useSyncExternalStore(subscribeBrand, getBrandConfig, getBrandConfig);
}
