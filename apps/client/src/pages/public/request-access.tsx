import { z } from "zod/v4";
import { useForm } from "@mantine/form";
import { zod4Resolver } from "mantine-form-zod-resolver";
import { useState } from "react";
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
import { notifications } from "@mantine/notifications";
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

  const form = useForm<FormValues>({
    validate: zod4Resolver(formSchema),
    initialValues: { email: "" },
  });

  async function onSubmit(values: FormValues) {
    setSubmitting(true);
    try {
      const res = await requestAccess(values);
      setDone(res.message);
      notifications.show({ message: res.message });
      setTimeout(() => navigate(APP_ROUTE.AUTH.LOGIN), 2500);
    } catch {
      notifications.show({
        color: "red",
        message: t(
          "We couldn't submit your request right now. Please try again later or contact an administrator.",
        ),
      });
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
              <TextInput
                id="email"
                type="email"
                label={t("Email")}
                placeholder="email@vanderbilt.edu"
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
