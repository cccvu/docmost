import { ActionIcon, Menu } from "@mantine/core";
import {
  IconDots,
  IconEdit,
  IconTrash,
  IconCircleCheck,
  IconCircleCheckFilled,
} from "@tabler/icons-react";
import { modals } from "@mantine/modals";
import { useTranslation } from "react-i18next";
import { useHasFeature } from "@/ee/hooks/use-feature";
import { Feature } from "@/ee/features";

type CommentMenuProps = {
  onEditComment: () => void;
  onDeleteComment: () => void;
  onResolveComment?: () => void;
  canEdit?: boolean;
  isResolved?: boolean;
  isParentComment?: boolean;
};

function CommentMenu({
  onEditComment,
  onDeleteComment,
  onResolveComment,
  canEdit = true,
  isResolved = false,
  isParentComment = false,
}: CommentMenuProps) {
  const { t } = useTranslation();
  const canResolve = useHasFeature(Feature.COMMENT_RESOLUTION);

  //@ts-ignore
  const openDeleteModal = () =>
    modals.openConfirmModal({
      title: t("Are you sure you want to delete this comment?"),
      centered: true,
      labels: { confirm: t("Delete"), cancel: t("Cancel") },
      confirmProps: { color: "red" },
      onConfirm: onDeleteComment,
    });

  return (
    <Menu shadow="md" width={200}>
      <Menu.Target>
        <ActionIcon
          variant="default"
          style={{ border: "none" }}
          aria-label={t("Comment menu")}
        >
          <IconDots size={20} stroke={2} />
        </ActionIcon>
      </Menu.Target>

      <Menu.Dropdown>
        {canEdit && (
          <Menu.Item
            onClick={onEditComment}
            leftSection={<IconEdit size={14} />}
          >
            {t("Edit comment")}
          </Menu.Item>
        )}
        {/* CCC: HIDE Resolve when unavailable (was disabled + upgrade tooltip). */}
        {isParentComment && canResolve && (
          <Menu.Item
            onClick={onResolveComment}
            leftSection={
              isResolved ? (
                <IconCircleCheckFilled size={14} />
              ) : (
                <IconCircleCheck size={14} />
              )
            }
          >
            {isResolved ? t("Re-open comment") : t("Resolve comment")}
          </Menu.Item>
        )}
        <Menu.Item
          leftSection={<IconTrash size={14} />}
          onClick={openDeleteModal}
        >
          {t("Delete comment")}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

export default CommentMenu;
