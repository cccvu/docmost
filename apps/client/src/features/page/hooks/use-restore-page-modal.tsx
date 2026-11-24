import { modals } from "@mantine/modals";
import { Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useFocusFallback } from "@/features/layout/use-focus-fallback";

type UseRestoreModalProps = {
  title?: string | null;
  onConfirm: () => void;
};

export function useRestorePageModal() {
  const { t } = useTranslation();
  const armFocusFallback = useFocusFallback(); // CCC (wiki-v2 #913): see onConfirm
  const openRestoreModal = ({ title, onConfirm }: UseRestoreModalProps) => {
    modals.openConfirmModal({
      title: t("Restore page"),
      children: (
        <Text size="sm">
          {t("Restore '{{title}}' and its sub-pages?", {
            title: title || t("Untitled"),
          })}
        </Text>
      ),
      centered: true,
      labels: { confirm: t("Restore"), cancel: t("Cancel") },
      confirmProps: { color: "blue" },
      onConfirm: () => {
        armFocusFallback(); // CCC (wiki-v2 #913): the trigger's row/node/banner may go
        onConfirm();
      },
    });
  };

  return { openRestoreModal } as const;
}
