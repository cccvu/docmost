import { Group, Text, Box, Badge } from "@mantine/core";
import React, { useEffect, useRef, useState } from "react";
import classes from "./comment.module.css";
import { useAtom, useAtomValue } from "jotai";
import { useTimeAgo } from "@/hooks/use-time-ago";
import CommentEditor from "@/features/comment/components/comment-editor";
import { pageEditorAtom } from "@/features/editor/atoms/editor-atoms";
import { isEditorReady } from "@docmost/editor-ext";
import CommentActions from "@/features/comment/components/comment-actions";
import CommentMenu from "@/features/comment/components/comment-menu";
import { useCommentResolutionAvailable } from "@/features/feature-availability/feature-gate";
import {
  enclosingTab,
  useFocusFallback,
} from "@/features/layout/use-focus-fallback";
import ResolveComment from "@/ee/comment/components/resolve-comment";
import { useFocusWithin, useHover, useMergedRef } from "@mantine/hooks";
import {
  useDeleteCommentMutation,
  useUpdateCommentMutation,
} from "@/features/comment/queries/comment-query";
import { useResolveCommentMutation } from "@/ee/comment/queries/comment-query";
import { IComment } from "@/features/comment/types/comment.types";
import { CustomAvatar } from "@/components/ui/custom-avatar.tsx";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom.ts";
import { useTranslation } from "react-i18next";

interface CommentListItemProps {
  comment: IComment;
  pageId: string;
  canComment: boolean;
  userSpaceRole?: string;
}

function CommentListItem({
  comment,
  pageId,
  canComment,
  userSpaceRole,
}: CommentListItemProps) {
  const { t } = useTranslation();
  const { hovered, ref } = useHover();
  // CCC #913: the actions also show while they hold keyboard focus. They are transparent, not
  // `visibility: hidden`, at rest, so Tab (and a screen reader) can reach them without a pointer.
  const { ref: actionsRef, focused: actionsFocused } = useFocusWithin();
  // CCC #913: a deleted comment (its menu held focus) hands focus to its comment tab, else the main content.
  const rootRef = useRef<HTMLDivElement>(null);
  const itemRef = useMergedRef(ref, rootRef);
  const focusTarget = useRef<HTMLElement | null>(null);
  const armFocusFallback = useFocusFallback(() => focusTarget.current);
  const [isEditing, setIsEditing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const editor = useAtomValue(pageEditorAtom);
  const [content, setContent] = useState<string>(comment.content);
  const editContentRef = useRef<any>(null);
  const updateCommentMutation = useUpdateCommentMutation();
  const deleteCommentMutation = useDeleteCommentMutation(comment.pageId);
  const resolveCommentMutation = useResolveCommentMutation();
  const [currentUser] = useAtom(currentUserAtom);
  // CCC #858: the fork serves /comments/resolve in both modes; the licence entitlement is never granted.
  const canResolve = useCommentResolutionAvailable();
  const createdAtAgo = useTimeAgo(comment.createdAt);

  useEffect(() => {
    setContent(comment.content);
  }, [comment]);

  async function handleUpdateComment() {
    try {
      setIsLoading(true);
      const commentToUpdate = {
        commentId: comment.id,
        content: JSON.stringify(editContentRef.current ?? content),
      };
      await updateCommentMutation.mutateAsync(commentToUpdate);
      if (editContentRef.current) {
        setContent(editContentRef.current);
        editContentRef.current = null;
      }
      setIsEditing(false);
    } catch (error) {
      console.error("Failed to update comment:", error);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleDeleteComment() {
    focusTarget.current = enclosingTab(rootRef.current);
    armFocusFallback();
    try {
      await deleteCommentMutation.mutateAsync(comment.id);
      if (isEditorReady(editor)) {
        editor.commands.unsetComment(comment.id);
      }
    } catch (error) {
      console.error("Failed to delete comment:", error);
    }
  }

  async function handleResolveComment() {
    if (!canResolve) return;
    
    try {
      const isResolved = comment.resolvedAt != null;
      
      await resolveCommentMutation.mutateAsync({
        commentId: comment.id,
        pageId: comment.pageId,
        resolved: !isResolved,
      });

      if (isEditorReady(editor)) {
        editor.commands.setCommentResolved(comment.id, !isResolved);
      }
    } catch (error) {
      console.error("Failed to toggle resolved state:", error);
    }
  }

  function handleCommentClick(comment: IComment) {
    const el = document.querySelector(
      `.comment-mark[data-comment-id="${comment.id}"]`,
    );
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("comment-highlight");
      setTimeout(() => {
        el.classList.remove("comment-highlight");
      }, 3000);
    }
  }

  function handleEditToggle() {
    setIsEditing(true);
  }
  function cancelEdit() {
    editContentRef.current = null;
    setIsEditing(false);
  }

  return (
    <Box ref={itemRef} pb="xs">
      <Group>
        <CustomAvatar
          size="sm"
          avatarUrl={comment.creator.avatarUrl}
          name={comment.creator.name}
        />

        <div style={{ flex: 1 }}>
          <Group justify="space-between" wrap="nowrap">
            <Text size="sm" fw={500} lineClamp={1}>
              {comment.creator.name}
            </Text>

            <div
              ref={actionsRef}
              style={{ opacity: hovered || actionsFocused ? 1 : 0 }}
            >
              {!comment.parentCommentId && canComment && canResolve && (
                <ResolveComment
                  editor={editor}
                  commentId={comment.id}
                  pageId={comment.pageId}
                  resolvedAt={comment.resolvedAt}
                />
              )}

              {(currentUser?.user?.id === comment.creatorId || userSpaceRole === 'admin') && (
                <CommentMenu
                  onEditComment={handleEditToggle}
                  onDeleteComment={handleDeleteComment}
                  onResolveComment={handleResolveComment}
                  canEdit={currentUser?.user?.id === comment.creatorId}
                  isResolved={comment.resolvedAt != null}
                  isParentComment={!comment.parentCommentId}
                />
              )}
            </div>
          </Group>

          <Group gap="xs">
            <Text size="xs" fw={500} c="dimmed">
              {createdAtAgo}
            </Text>
          </Group>
        </div>
      </Group>

      <div>
        {!comment.parentCommentId && comment?.selection && (
          <Box
            className={classes.textSelection}
            onClick={() => handleCommentClick(comment)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleCommentClick(comment);
              }
            }}
            role="button"
            tabIndex={0}
            aria-label={t("Jump to comment selection")}
          >
            <Text size="sm">{comment?.selection}</Text>
          </Box>
        )}

        {!isEditing ? (
          <CommentEditor defaultContent={content} editable={false} />
        ) : (
          <>
            <CommentEditor
              defaultContent={content}
              editable={true}
              onUpdate={(newContent: any) => { editContentRef.current = newContent; }}
              onSave={handleUpdateComment}
              autofocus={true}
            />

            <CommentActions
              onSave={handleUpdateComment}
              isLoading={isLoading}
              onCancel={cancelEdit}
              isCommentEditor={true}
            />
          </>
        )}
      </div>
    </Box>
  );
}

export default CommentListItem;
