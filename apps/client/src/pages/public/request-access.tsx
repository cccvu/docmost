import { z } from "zod/v4";
import { useForm } from "@mantine/form";
import { zod4Resolver } from "mantine-form-zod-resolver";
import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Container,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { Helmet } from "react-helmet-async";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PublicShell } from "@/features/public/components/public-shell.tsx";
import { requestAccess } from "@/features/public/services/public-service.ts";
import APP_ROUTE from "@/lib/app-route.ts";
import { getAppName } from "@/lib/config.ts";

// Passwordless: request access captures only an email. Sign-in is via magic link + OTP once approved.
const formSchema = z.object({
  email: z.email().min(1, { message: "Email is required" }),
});
type FormValues = z.infer<typeof formSchema>;

export default function RequestAccess() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<FormValues>({
    validate: zod4Resolver(formSchema),
    initialValues: { email: "" },
  });

  // After a successful request, redirect to sign-in. Held in an effect so the timer is cleared if the
  // visitor navigates away within the window — no navigate() on an unmounted component (#29).
  useEffect(() => {
    if (!done) return;
    const id = window.setTimeout(() => navigate(APP_ROUTE.AUTH.LOGIN), 2500);
    return () => window.clearTimeout(id);
  }, [done, navigate]);

  async function onSubmit(values: FormValues) {
    setSubmitting(true);
    setError(null);
    try {
      const res = await requestAccess(values);
      setDone(res.message);
    } catch {
      // Inline, form-associated alert (role="alert") so submit failures reach screen readers — mirrors
      // the success Alert (role="status"). No toast: one accessible feedback channel per state (#29).
      setError(
        t(
          "We couldn't submit your request right now. Please try again later or contact an administrator.",
        ),
      );
    } finally {
      setSubmitting(false);
    }
  }

  function handleValidationFailure(errors: Record<string, unknown>) {
    const firstInvalidId = Object.keys(errors)[0];
    if (firstInvalidId) {
      document.getElementById(firstInvalidId)?.focus();
    }
  }

  return (
    <>
      <Helmet>
        <title>
          {t("Request access")} — {getAppName()}
        </title>
      </Helmet>

      <PublicShell>
        <Container size={460} py={{ base: 32, sm: 64 }}>
          <Title order={1} size="h2" ta="center" fw={600} mb="xs">
            {t("Request access")}
          </Title>
          <Text c="dimmed" ta="center" mb="lg">
            {t(
              "Create an access request. An administrator reviews and approves new accounts before they can sign in.",
            )}
          </Text>

          {done ? (
            <Alert color="green" title={t("Request submitted")} role="status">
              {done}
            </Alert>
          ) : (
            <form onSubmit={form.onSubmit(onSubmit, handleValidationFailure)}>
              {error && (
                <Alert color="red" role="alert" mb="md">
                  {error}
                </Alert>
              )}
              <TextInput
                id="email"
                type="email"
                label={t("Email")}
                placeholder="email@example.edu"
                autoComplete="email"
                errorProps={{ role: "alert" }}
                {...form.getInputProps("email")}
              />
              <Button type="submit" fullWidth mt="lg" loading={submitting}>
                {t("Request access")}
              </Button>
            </form>
          )}
        </Container>
      </PublicShell>
    </>
  );
}
