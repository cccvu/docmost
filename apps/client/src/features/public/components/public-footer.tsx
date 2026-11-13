import { Anchor, Container, Divider, Group, Text } from "@mantine/core";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import APP_ROUTE, { loginHrefWithReturn } from "@/lib/app-route.ts";
import { useBrandConfig } from "@/features/brand/brand-hooks.ts";
import { isNativeAuthEnabled } from "@/features/auth-native/lib/auth-mode.ts";

export function PublicFooter({ year }: { year: number }) {
  const { t } = useTranslation();
  const brand = useBrandConfig();

  return (
    <Container size="lg" component="footer" pb="xl">
      <Divider mb="lg" />
      <Group justify="space-between" wrap="wrap" gap="sm">
        <Text size="sm" c="dimmed">
          © {year} {brand.name}
          {brand.institutionName ? ` · ${brand.institutionName}` : ""}
        </Text>
        <Group gap="lg">
          <Anchor component={Link} to={loginHrefWithReturn()} size="sm">
            {t("Log in")}
          </Anchor>
          {/* The request-access page posts to the platform; native (standalone) mode has none. */}
          {!isNativeAuthEnabled() && (
            <Anchor component={Link} to={APP_ROUTE.AUTH.REQUEST_ACCESS} size="sm">
              {t("Request access")}
            </Anchor>
          )}
          {/* AGPL-3.0 §13: a prominent, standing offer of the Corresponding
              Source for this network-served, modified Docmost. Keep this link, and keep it
              pointing at the PUBLIC fork (the wiki-v2 super-repo is private, a public 404). */}
          <Anchor
            href="https://github.com/cccvu/docmost/tree/wiki-v2"
            target="_blank"
            rel="noreferrer"
            size="sm"
            c="dimmed"
          >
            {t("Source")}
          </Anchor>
        </Group>
      </Group>
    </Container>
  );
}
