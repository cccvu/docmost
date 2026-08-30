import { type ReactNode } from "react";
import { AppShell, Group, Text } from "@mantine/core";
import { Link } from "react-router-dom";
import { ThemeToggle } from "@/components/theme-toggle.tsx";
import { MAIN_CONTENT_ID, SkipToMain } from "@/components/ui/skip-to-main.tsx";
import { useWorkspacePublicDataQuery } from "@/features/workspace/queries/workspace-query.ts";
import { getAppName } from "@/lib/config.ts";
import { PublicAuthButtons } from "./public-auth-buttons.tsx";

/**
 * A lightweight, header-only app shell for the anonymous public surface (front page + request-access).
 * Kept separate from ShareShell (which carries share-specific tree/TOC machinery). Brand is pulled
 * from the `@Public` workspace data, falling back to the app name so the header never flashes empty.
 */
export function PublicShell({ children }: { children: ReactNode }) {
  const { data: workspace } = useWorkspacePublicDataQuery();
  const name = workspace?.name || getAppName();

  return (
    <>
      <SkipToMain />
      <AppShell header={{ height: 60 }} padding="md">
        <AppShell.Header>
          <Group h="100%" px="md" justify="space-between" wrap="nowrap">
            <Link
              to="/"
              aria-label={name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                textDecoration: "none",
                color: "inherit",
                minWidth: 0,
              }}
            >
              {/* decorative — the workspace name beside it carries the accessible name */}
              <img
                src="/icons/favicon-32x32.png"
                alt=""
                width={24}
                height={24}
              />
              <Text size="lg" fw={600} lineClamp={1} style={{ userSelect: "none" }}>
                {name}
              </Text>
            </Link>

            <Group gap="sm" wrap="nowrap">
              <ThemeToggle />
              <PublicAuthButtons />
            </Group>
          </Group>
        </AppShell.Header>

        <AppShell.Main id={MAIN_CONTENT_ID} tabIndex={-1}>
          {children}
        </AppShell.Main>
      </AppShell>
    </>
  );
}
