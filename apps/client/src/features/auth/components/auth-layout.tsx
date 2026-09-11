import React from "react";
import { Group } from "@mantine/core";
import classes from "./auth.module.css";
import { Brand } from "@/features/brand/brand-logo";
import { getAppName } from "@/lib/config.ts";

type AuthLayoutProps = {
  children: React.ReactNode;
};

export function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <>
      <Group justify="center" className={classes.logo}>
        {/* Not wrapped in a labelled control, so the runtime wordmark art (when a brand bundle is
            served) or the app-name fallback carries the accessible name. */}
        <Brand variant="lockup" appName={getAppName()} lockupHeight={30} />
      </Group>
      <main>{children}</main>
    </>
  );
}
