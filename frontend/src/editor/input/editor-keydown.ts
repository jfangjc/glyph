import type { DocumentEditorEventContext } from "../../formats/types";
import {
    indentListBlocks,
    mergeForward,
    removeOrMergeBackward,
    removeTrailingLineBreakInMultilinePlainTextBlock,
    splitBlock,
} from "../blocks/operations";
import {
    getSiblingBlock,
    isMultilinePlainTextBlockType,
} from "../blocks/view";
import { readBlockType } from "../blocks/model";
import {
    getActiveBlock,
    getSelectedBlockRange,
    isCaretAtBlockEdge,
    selectEditorContents,
} from "../selection/caret";
import { getElement } from "../../utils/dom";
import {
    isCompositionEvent,
    isPlainTextKey,
    isSelectAllShortcut,
} from "./keyboard-shortcuts";
import {
    deleteSelectedContent,
    replaceSelectionWithText,
} from "../selection/commands";

export function handleEditorKeydown(event: KeyboardEvent, options: DocumentEditorEventContext): void {
    const editor = getElement<HTMLElement>("editor");

    if (isCompositionEvent(event, options.isComposingText)) {
        return;
    }

    if (isSelectAllShortcut(event)) {
        event.preventDefault();
        selectEditorContents(editor);
        return;
    }

    const block = getActiveBlock(event.target);
    if (!block) {
        return;
    }

    if (event.key === "Tab" && indentListBlocks(block, event.shiftKey ? -1 : 1)) {
        event.preventDefault();
        options.markEditorDirty();
        return;
    }

    if (event.key === "Enter") {
        event.preventDefault();
        const targetBlock = deleteSelectedContent() ?? block;

        if (isMultilinePlainTextBlockType(readBlockType(targetBlock.dataset.type)) && !event.ctrlKey && !event.metaKey) {
            replaceSelectionWithText(targetBlock, "\n");
            options.markEditorDirty();
            return;
        }

        splitBlock(targetBlock);
        options.markEditorDirty();
        return;
    }

    if (event.key === "Backspace" || event.key === "Delete") {
        if (
            readBlockType(block.dataset.type) === "source" &&
            event.key === "Backspace" &&
            isCaretAtBlockEdge(block, "start")
        ) {
            event.preventDefault();
            return;
        }

        if (
            event.key === "Backspace" &&
            readBlockType(block.dataset.type) === "paragraph" &&
            isCaretAtBlockEdge(block, "start") &&
            !getSiblingBlock(block, "previous")
        ) {
            event.preventDefault();
            return;
        }

        if (
            event.key === "Delete" &&
            readBlockType(block.dataset.type) !== "code" &&
            isCaretAtBlockEdge(block, "end") &&
            !getSiblingBlock(block, "next")
        ) {
            event.preventDefault();
            return;
        }

        if (deleteSelectedContent()) {
            event.preventDefault();
            options.markEditorDirty();
            return;
        }

        if (event.key === "Backspace" && removeTrailingLineBreakInMultilinePlainTextBlock(block)) {
            event.preventDefault();
            options.markEditorDirty();
            return;
        }

        if (event.key === "Backspace" && removeOrMergeBackward(block)) {
            event.preventDefault();
            options.markEditorDirty();
            return;
        }

        if (event.key === "Delete" && mergeForward(block)) {
            event.preventDefault();
            options.markEditorDirty();
            return;
        }
    }

    if (isPlainTextKey(event) && getSelectedBlockRange()) {
        event.preventDefault();
        replaceSelectionWithText(block, event.key);
        options.markEditorDirty();
    }
}
