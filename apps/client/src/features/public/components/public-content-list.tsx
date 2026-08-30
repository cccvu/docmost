import {
  Card,
  Container,
  Group,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { usePublicContentQuery } from "@/features/public/queries/public-query.ts";
import { IPublicPage } from "@/features/public/services/public-service.ts";

function pageHref(p: IPublicPage): string {
  return `/share/${p.shareKey}/p/${p.slugId}`;
}

export function PublicContentList() {
  const { t } = useTranslation();
  const { data, isLoading, isError } = usePublicContentQuery();

  // Discovery is an enhancement layered on the hero: if the endpoint errors, hide the section rather
  // than block the page. (It never leaks — the endpoint lists only explicitly-public pages.)
  if (isError) return null;

  return (
    <Container size="lg" pb={{ base: 48, sm: 80 }} id="browse">
      <Stack gap="lg">
        <Title order={2} size="h3">
          {t("Explore public pages")}
        </Title>

        {isLoading ? (
          <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} height={110} radius="md" />
            ))}
          </SimpleGrid>
        ) : data && data.items.length > 0 ? (
          <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md">
            {data.items.map((p) => (
              <Card
                key={p.pageId}
                component={Link}
                to={pageHref(p)}
                withBorder
                padding="lg"
                radius="md"
              >
                <Group gap="xs" wrap="nowrap" align="flex-start">
                  {p.icon && (
                    <Text component="span" aria-hidden>
                      {p.icon}
                    </Text>
                  )}
                  <Text fw={600} lineClamp={2}>
                    {p.title || t("Untitled")}
                  </Text>
                </Group>
                {p.spaceName && (
                  <Text size="sm" c="dimmed" mt="xs" lineClamp={1}>
                    {p.spaceName}
                  </Text>
                )}
              </Card>
            ))}
          </SimpleGrid>
        ) : (
          <Text c="dimmed">
            {t("No public pages have been published yet. Check back soon.")}
          </Text>
        )}
      </Stack>
    </Container>
  );
}
