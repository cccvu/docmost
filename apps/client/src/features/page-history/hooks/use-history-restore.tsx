import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useParams } from "react-router-dom";
import {
  activeHistoryIdAtom,
  historyAtoms,
} from "@/features/page-history/atoms/history-atoms";
import { usePageHistoryQuery } from "@/features/page-history/queries/page-history-query";
import {
  pageEditorAtom,
  titleEditorAtom,
} from "@/features/editor/atoms/editor-atoms";
import { usePageQuery } from "@/features/page/queries/page-query";
import { extractPageSlugId } from "@/lib";

export function useHistoryRestore() {
  const { t } = useTranslation();

  const activeHistoryId = useAtomValue(activeHistoryIdAtom);
  const { data: activeHistoryData } = usePageHistoryQuery(activeHistoryId);

  const mainEditor = useAtomValue(pageEditorAtom);
  const mainEditorTitle = useAtomValue(titleEditorAtom);
  const setHistoryModalOpen = useSetAtom(historyAtoms);

  // CCC (wiki-v2 UI cleanup, #858): Restore is the page's own edit right: the same cached page
  // query and the same canEdit as pages/page/page.tsx. That is the server's edit decision
  // (page-access validateCanEdit, collab's read-only flag), so a space writer is not offered
  // Restore on a restricted page they cannot edit, and a page-only editor (a space reader with
  // an edit grant) is. Restore only sets editor content; the server checks those writes.
  const { pageSlug } = useParams();
  const { data: page } = usePageQuery({ pageId: extractPageSlugId(pageSlug) });
  const canEditPage = !page?.deletedAt && (page?.permissions?.canEdit ?? false);

  const canRestore = canEditPage;

  const handleRestore = useCallback(() => {
    if (!activeHistoryData) return;
    if (
      !mainEditor ||
      mainEditor.isDestroyed ||
      !mainEditorTitle ||
      mainEditorTitle.isDestroyed
    ) {
      return;
    }

    mainEditorTitle
      .chain()
      .clearContent()
      .setContent(activeHistoryData.title, { emitUpdate: true })
      .run();

    mainEditor
      .chain()
      .clearContent()
      .setContent(activeHistoryData.content)
      .run();

    setHistoryModalOpen(false);
    notifications.show({ message: t("Successfully restored") });
  }, [activeHistoryData, mainEditor, mainEditorTitle, setHistoryModalOpen, t]);

  const confirmRestore = useCallback(() => {
    modals.openConfirmModal({
      title: t("Please confirm your action"),
      children: (
        <Text size="sm">
          {t(
            "Are you sure you want to restore this version? Any changes not versioned will be lost.",
          )}
        </Text>
      ),
      labels: { confirm: t("Confirm"), cancel: t("Cancel") },
      onConfirm: handleRestore,
    });
  }, [t, handleRestore]);

  return { canRestore, confirmRestore };
}
