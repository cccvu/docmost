import { Affix, Paper } from "@mantine/core";
import { Link } from "react-router-dom";
import { Brand } from "@/features/brand/brand-logo.tsx";
import { getAppName } from "@/lib/config.ts";

/**
 * Subtle brand affix on anonymous shared pages. Replaces the upstream
 * "Powered by Docmost" promo (a removable cosmetic trademark) with the CCC mark
 * linking home — an on-brand way in for anonymous readers.
 */
export default function ShareBranding() {
  return (
    <Affix position={{ bottom: 20, right: 20 }}>
      <Paper
        component={Link}
        to="/"
        aria-label={`${getAppName()} home`}
        // Paper doesn't carry Mantine's focus ring by default; opt in so keyboard
        // focus on this link matches the app's ring, not just the UA outline.
        className="mantine-focus-auto"
        withBorder
        shadow="xs"
        radius="xl"
        px="sm"
        py={6}
        style={{
          display: "flex",
          alignItems: "center",
          textDecoration: "none",
          color: "inherit",
        }}
      >
        <Brand variant="compact" appName={getAppName()} iconHeight={18} />
      </Paper>
    </Affix>
  );
}
