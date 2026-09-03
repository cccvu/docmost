import { atom } from "jotai";
import { Editor } from "@tiptap/core";
import { PageEditMode } from "@/features/user/types/user.types.ts";

export const pageEditorAtom = atom<Editor | null>(null);

export const titleEditorAtom = atom<Editor | null>(null);

export const readOnlyEditorAtom = atom<Editor | null>(null);

export const yjsConnectionStatusAtom = atom<string>("");

export const yjsSyncedAtom = atom<boolean>(false);

export const showAiMenuAtom = atom(false);

export const showLinkMenuAtom = atom(false);

// Current page's edit mode — initialized from the user's saved preference on
// first load (see full-editor precedence), can be toggled locally without
// persisting to the server. CCC: defaults to READ so pages open read-only until
// the resolved preference is applied — prevents accidental edits.
export const currentPageEditModeAtom = atom<PageEditMode>(PageEditMode.Read);
