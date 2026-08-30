import React from "react";
import { Group } from "@mantine/core";
import classes from "./auth.module.css";
import { Brand, INSTITUTION_NAME } from "@/features/brand/brand-logo";
import { getAppName } from "@/lib/config.ts";

type AuthLayoutProps = {
  children: React.ReactNode;
};

export function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <>
      <Group justify="center" className={classes.logo}>
        {/* Not wrapped in a labelled control, so the artwork carries the name. */}
        <Brand
          variant="lockup"
          appName={getAppName()}
          lockupHeight={30}
          alt={INSTITUTION_NAME}
        />
      </Group>
      <main>{children}</main>
    </>
  );
}
