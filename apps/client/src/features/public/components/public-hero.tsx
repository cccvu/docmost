import { Button, Container, Group, Stack, Text, Title } from "@mantine/core";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { loginHrefWithReturn } from "@/lib/app-route.ts";

export function PublicHero({ workspaceName }: { workspaceName: string }) {
  const { t } = useTranslation();

  return (
    <Container size="lg" py={{ base: 48, sm: 80 }}>
      <Stack gap="lg" align="center" ta="center">
        <Title
          order={1}
          fw={700}
          style={{ fontSize: "clamp(2rem, 5vw, 3rem)", lineHeight: 1.1 }}
        >
          {workspaceName}
        </Title>

        <Text size="lg" c="dimmed" maw={640}>
          {t(
            "A shared knowledge base for staff, faculty, students, and the public. Browse the pages published here, or log in for full access.",
          )}
        </Text>

        <Group justify="center" gap="sm">
          {/* Bright Vanderbilt gold (shade 6) in both themes; autoContrast +
              explicit dark text keeps the label legible on gold. */}
          <Button component="a" href="#browse" size="md" color="gold.6" c="black">
            {t("Browse public content")}
          </Button>
          <Button
            component={Link}
            to={loginHrefWithReturn()}
            size="md"
            variant="default"
          >
            {t("Log in")}
          </Button>
        </Group>
      </Stack>
    </Container>
  );
}
