import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import * as path from "path";

const envPath = path.resolve(process.cwd(), "..", "..");

export default defineConfig(({ mode }) => {
  const {
    APP_URL,
    FILE_UPLOAD_SIZE_LIMIT,
    FILE_IMPORT_SIZE_LIMIT,
    DRAWIO_URL,
    CLOUD,
    SUBDOMAIN_HOST,
    COLLAB_URL,
    BILLING_TRIAL_DAYS,
    POSTHOG_HOST,
    POSTHOG_KEY,
    PLATFORM_URL,
  } = loadEnv(mode, envPath, "");

  return {
    define: {
      "process.env": {
        APP_URL,
        FILE_UPLOAD_SIZE_LIMIT,
        FILE_IMPORT_SIZE_LIMIT,
        DRAWIO_URL,
        CLOUD,
        SUBDOMAIN_HOST,
        COLLAB_URL,
        BILLING_TRIAL_DAYS,
        POSTHOG_HOST,
        POSTHOG_KEY,
      },
      APP_VERSION: JSON.stringify(process.env.npm_package_version),
    },
    plugins: [react()],
    build: {
      rolldownOptions: {
        output: {
          advancedChunks: {
            groups: [
              {
                name: "vendor-mantine",
                test: /[\\/]node_modules[\\/]@mantine[\\/]/,
              },
            ],
          },
        },
      },
    },
    resolve: {
      alias: {
        "@": "/src",
      },
    },
    server: {
      proxy: {
        "/api": {
          target: APP_URL,
          changeOrigin: false,
        },
        // Gated registration (request-access) lives on the platform service. In dev, forward /auth
        // to it so the isolated platformApi call reaches it same-origin.
        "/auth": {
          target: PLATFORM_URL || "http://localhost:4000",
          changeOrigin: true,
        },
        // The BFF (platform → Docmost session exchange) also lives on the platform. Forward /bff so
        // the browser sees /bff/docmost/session as same-origin in dev — this makes the relayed
        // Docmost `authToken` cookie bind to the dev origin (mirroring prod's single-ALB origin).
        "/bff": {
          target: PLATFORM_URL || "http://localhost:4000",
          changeOrigin: true,
        },
        // CCC admin surface — same-origin like prod (the ALB routes these to the platform). AdminEntryLink
        // calls /admin/context to decide whether to show the top-right "Admin" link, and the link is a
        // full-page navigation to /console (the admin console SPA the platform serves). Without these two
        // the /admin/context probe hits the Vite SPA fallback (not the platform) and the link never shows.
        "/admin": {
          target: PLATFORM_URL || "http://localhost:4000",
          changeOrigin: true,
        },
        "/console": {
          target: PLATFORM_URL || "http://localhost:4000",
          changeOrigin: true,
        },
        "/socket.io": {
          target: APP_URL,
          ws: true,
          rewriteWsOrigin: true,
        },
        "/collab": {
          target: APP_URL,
          ws: true,
          rewriteWsOrigin: true,
        },
      },
    },
  };
});
