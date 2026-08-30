import {
  Card,
  Container,
  SimpleGrid,
  Text,
  ThemeIcon,
} from "@mantine/core";
import {
  IconLockOpen,
  IconSearch,
  IconWorld,
} from "@tabler/icons-react";
import { Helmet } from "react-helmet-async";
import { useTranslation } from "react-i18next";
import { PublicShell } from "@/features/public/components/public-shell.tsx";
import { PublicHero } from "@/features/public/components/public-hero.tsx";
import { PublicContentList } from "@/features/public/components/public-content-list.tsx";
import { PublicFooter } from "@/features/public/components/public-footer.tsx";
import { useWorkspacePublicDataQuery } from "@/features/workspace/queries/workspace-query.ts";
import { getAppName } from "@/lib/config.ts";

function ValueCard({
  icon,
  title,
  desc,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <Card withBorder padding="lg" radius="md">
      <ThemeIcon variant="light" size="lg" radius="md" mb="sm">
        {icon}
      </ThemeIcon>
      <Text fw={600} mb={4}>
        {title}
      </Text>
      <Text size="sm" c="dimmed">
        {desc}
      </Text>
    </Card>
  );
}

export default function PublicHome() {
  const { t } = useTranslation();
  const { data: workspace } = useWorkspacePublicDataQuery();
  const name = workspace?.name || getAppName();
  const title = workspace?.name
    ? `${workspace.name} — ${getAppName()}`
    : getAppName();
  const year = new Date().getFullYear();

  return (
    <>
      <Helmet>
        <title>{title}</title>
      </Helmet>

      <PublicShell>
        <PublicHero workspaceName={name} />

        <Container size="lg" pb={{ base: 32, sm: 48 }}>
          <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="lg">
            <ValueCard
              icon={<IconWorld size={20} aria-hidden />}
              title={t("Public by design")}
              desc={t(
                "Pages published for the public are readable by anyone — no account required.",
              )}
            />
            <ValueCard
              icon={<IconLockOpen size={20} aria-hidden />}
              title={t("Secure by default")}
              desc={t(
                "Everything else stays private. Only content explicitly marked public appears here.",
              )}
            />
            <ValueCard
              icon={<IconSearch size={20} aria-hidden />}
              title={t("Easy to explore")}
              desc={t(
                "Browse published pages below, or log in to search and access your spaces.",
              )}
            />
          </SimpleGrid>
        </Container>

        <PublicContentList />

        <PublicFooter year={year} />
      </PublicShell>
    </>
  );
}
