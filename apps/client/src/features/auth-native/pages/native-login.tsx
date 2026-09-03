import { FormEvent, useState } from "react";
import {
  Anchor,
  Button,
  Container,
  PasswordInput,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PublicShell } from "@/features/public/components/public-shell";
import { getAppName, isCloud } from "@/lib/config";
import { useNativeLogin } from "../hooks/use-native-login";

/**
 * CCC native (standalone) sign-in page — NOT upstream Docmost code.
 *
 * Rendered at `/login` ONLY when the server reports `NATIVE_AUTH_ENABLED` (AUTHZ_MODE=native). Collects
 * email + password and posts to Docmost's own `/api/auth/login`. In remote mode `/login` renders the
 * platform passwordless flow instead. A fresh install links to first-run workspace setup.
 */
export default function NativeLogin() {
  const { t } = useTranslation();
  const { signIn, isLoading } = useNativeLogin();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) return;
    await signIn(email, password);
  }

  return (
    <>
      <Helmet>
        <title>
          {t("Sign in")} — {getAppName()}
        </title>
      </Helmet>

      <PublicShell>
        <Container size={460} py={{ base: 32, sm: 64 }}>
          <Title order={1} size="h2" ta="center" fw={600} mb="lg">
            {t("Sign in")}
          </Title>

          <form onSubmit={onSubmit}>
            <TextInput
              id="email"
              type="email"
              label={t("Email")}
              placeholder="you@example.com"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
            />
            <PasswordInput
              id="password"
              label={t("Password")}
              autoComplete="current-password"
              required
              mt="md"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
            />
            <Button type="submit" fullWidth mt="lg" loading={isLoading}>
              {t("Sign in")}
            </Button>
          </form>

          {!isCloud() && (
            <Text ta="center" mt="md" size="sm" c="dimmed">
              {t("First time here?")}{" "}
              <Anchor component={Link} to={"/setup/register"}>
                {t("Set up your workspace")}
              </Anchor>
            </Text>
          )}
        </Container>
      </PublicShell>
    </>
  );
}
