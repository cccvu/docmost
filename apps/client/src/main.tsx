import "@mantine/core/styles.css";
import "@mantine/spotlight/styles.css";
import "@mantine/notifications/styles.css";
import '@mantine/dates/styles.css';
import "@/styles/a11y-overrides.css";
import "@/features/brand/fonts";

import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import { mantineCssResolver, theme } from "@/theme";
import { MantineProvider } from "@mantine/core";
import { BrowserRouter } from "react-router-dom";
import { ModalsProvider } from "@mantine/modals";
import { Notifications } from "@mantine/notifications";
import { QueryClientProvider } from "@tanstack/react-query";
import { createAppQueryClient } from "@/features/request-errors/query-client.ts";
import { HelmetProvider } from "react-helmet-async";
import "./i18n";
import { PostHogAnalytics } from "@/features/analytics/posthog-analytics.tsx";
import { loadBrandConfig } from "@/features/brand/brand-config.ts";

// #384: same defaults as before, plus one retry for the fork's short rate limit and a deduped 429 toast.
export const queryClient = createAppQueryClient();

const container = document.getElementById("root") as HTMLElement;
const root = (container as any).__reactRoot ??= ReactDOM.createRoot(container);

// Runtime brand bundle (issue #30 follow-up): the fork ships no institution trademarks, so fetch the
// platform's /brand manifest (bounded; neutral fallback when absent) before the first render — that way
// every getAppName() page title renders branded without a flash of the generic name.
void loadBrandConfig().finally(() => {
  root.render(
    <BrowserRouter>
      <MantineProvider theme={theme} cssVariablesResolver={mantineCssResolver}>
        <ModalsProvider>
          <QueryClientProvider client={queryClient}>
            <Notifications position="bottom-center" limit={3} zIndex={10000} />
            <HelmetProvider>
              <PostHogAnalytics>
                <App />
              </PostHogAnalytics>
            </HelmetProvider>
          </QueryClientProvider>
        </ModalsProvider>
      </MantineProvider>
    </BrowserRouter>,
  );
});
