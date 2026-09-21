import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import * as path from "path";
import { precompressAndBudget } from "./build/precompress";

const envPath = path.resolve(process.cwd(), "..", "..");

// Asset delivery (#309). Vendor code is split off the entry into a few stable, cacheable chunks so an
// app-only change does not invalidate the React/Mantine/editor bytes, and the fork-owned plugin
// (apps/client/build/precompress.ts) measures the initial set, enforces the lazy-loading invariants and
// writes .br/.gz siblings that @fastify/static serves via `preCompressed`. Every group carries the
// `$initial` tag: only modules already on the eager static-import graph are captured, so a catch-all
// can never drag a lazy-only dependency (mermaid, excalidraw, …) into an eagerly preloaded chunk.
const NODE_MODULES = "[\\\\/]node_modules[\\\\/]"; // pnpm: node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>/
// A package spec is an exact name (`react`, `@tanstack/react-query`) or a prefix with a trailing `*`
// (`@mantine/*`, `prosemirror-*`). Matching is anchored on the package-name segment, so `react` does not
// capture `react-i18next` and `mermaid` would not capture `mermaid-foo`.
// Order matters: the `/` -> `[\\/]` rewrite must run BEFORE `*` expands to a class containing `/`.
const pkgPattern = (spec: string) =>
  spec
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\//g, "[\\\\/]")
    .replace(/\*/g, "[^\\\\/]*");
const vendorGroup = (name: string, priority: number, packages: string[]) => ({
  name,
  priority,
  tags: ["$initial" as const],
  test: new RegExp(
    `${NODE_MODULES}(?:${packages.map(pkgPattern).join("|")})[\\\\/]`,
  ),
});

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
    plugins: [
      react(),
      precompressAndBudget({
        // Budgets (#309): the post-split initial set measured 790,161 B brotli JS / 48,435 B CSS on 2026-09-18.
        // #406 (lazy posthog-js) + #408 (lazy date-fns locales) cut it to 722,673 B JS / 48,435 B CSS on
        // 2026-09-21, so the JS ceiling is tightened to 790,000 (~9% headroom). Raising it is a deliberate PR
        // decision; a dependency bump that crosses it is a conversation, not a number to bump.
        budget: { initialJsBrotli: 790_000, initialCssBrotli: 60_000 },
        mustStayLazy: [
          "mermaid",
          "@mermaid-js",
          "@excalidraw",
          "@slidoapp",
          "katex",
          "@tanstack/react-table",
          // #406: posthog-js (incl. its posthog-js/react subpath) is loaded via a runtime dynamic import,
          // gated on isCloud() — a self-hosted visitor never downloads it. Guards against a future eager
          // re-import silently re-inflating first paint (matches both core and /react under node_modules/).
          "posthog-js",
        ],
      }),
    ],
    build: {
      rolldownOptions: {
        output: {
          // Rolldown `codeSplitting` (the successor of the deprecated `advancedChunks`, same shape).
          // Higher priority wins; a module captured by one group is removed from the others.
          codeSplitting: {
            groups: [
              vendorGroup("vendor-react", 60, [
                "react",
                "react-dom",
                "scheduler",
                "react-router",
                "react-router-dom",
                "@tanstack/react-query",
                "@tanstack/query-core",
                "jotai",
              ]),
              vendorGroup("vendor-mantine", 50, [
                "@mantine/*",
                "@floating-ui/*",
              ]),
              vendorGroup("vendor-editor", 40, [
                "@tiptap/*",
                "prosemirror-*",
                "yjs",
                "y-prosemirror",
                "y-indexeddb",
                "lib0",
                "@hocuspocus/*",
              ]),
              vendorGroup("vendor-icons", 30, ["@tabler/icons-react"]),
              vendorGroup("vendor-hljs", 20, [
                "highlight.js",
                "lowlight",
                "highlightjs-sap-abap",
              ]),
              {
                // Everything else from node_modules that is on the eager graph — `$initial` keeps
                // lazy-only deps out; minSize avoids a chunk for a handful of tiny helpers.
                name: "vendor",
                priority: 10,
                tags: ["$initial" as const],
                test: new RegExp(NODE_MODULES),
                minSize: 20_000,
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
        // Runtime brand bundle (issue #30 follow-up) — the fork fetches /brand/manifest.json at boot;
        // in prod the ALB routes /brand to the platform, so mirror that here (neutral fallback if down).
        "/brand": {
          target: PLATFORM_URL || "http://localhost:4000",
          changeOrigin: true,
        },
        // OAuth 2.1 AS + RFC 9728/8414 discovery live on the platform (#226). In prod the ALB routes /oauth
        // and /.well-known to the platform; mirror that here so the MCP OAuth flow — including the post-login
        // resume of /oauth/authorize (#302, a full-page navigation back to a platform route) — is reachable at
        // the dev single origin. Without these, /oauth/* falls through to the SPA fallback (index.html) in dev.
        "/oauth": {
          target: PLATFORM_URL || "http://localhost:4000",
          changeOrigin: true,
        },
        "/.well-known": {
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
