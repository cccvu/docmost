import { Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { requestErrorMessage } from "./request-error";

type Props = {
  error: unknown;
  // The page's existing, already-translated failure text ("Failed to fetch recent pages").
  fallback: string;
};

// #384: the list pages' error line, now saying whether it was a rate limit, the network, or an HTTP status.
// Same bare <Text> the call sites rendered before, so the layout does not move.
export function RequestErrorText({ error, fallback }: Props) {
  const { t } = useTranslation();
  return <Text>{requestErrorMessage(error, t, fallback)}</Text>;
}
