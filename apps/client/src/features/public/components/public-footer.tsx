import { Anchor, Container, Divider, Group, Text } from "@mantine/core";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import APP_ROUTE, { loginHrefWithReturn } from "@/lib/app-route.ts";
import { getAppName } from "@/lib/config.ts";

export function PublicFooter({ year }: { year: number }) {
  const { t } = useTranslation();

  return (
    <Container size="lg" component="footer" pb="xl">
      <Divider mb="lg" />
      <Group justify="space-between" wrap="wrap" gap="sm">
        <Text size="sm" c="dimmed">
          © {year} {getAppName()}
        </Text>
        <Group gap="lg">
          <Anchor component={Link} to={loginHrefWithReturn()} size="sm">
            {t("Log in")}
          </Anchor>
          <Anchor component={Link} to={APP_ROUTE.AUTH.REQUEST_ACCESS} size="sm">
            {t("Request access")}
          </Anchor>
        </Group>
      </Group>
    </Container>
  );
}
