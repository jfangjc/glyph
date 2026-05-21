import {
    insertLineBreakInOpenCodeFenceParagraph,
    removeTrailingLineBreakInOpenCodeFenceParagraph,
    startCodeBlockFromFence,
    startTableFromHeader,
} from "../../formats/markdown/editor/block-operations";
import {
    moveCaretAfterCodeBlockSourceAtSelection,
    moveCaretIntoCodeBlockSourceAtBoundary,
    handleBlockMarkdownSourceKeydown,
    trackVerticalBlockSourceNavigation,
} from "../../formats/markdown/editor/source-controller";
import {
    moveCaretOutOfActiveMarkdownTokenSource,
    trackHorizontalMarkdownNavigation,
    trackVerticalLeadingTokenNavigation,
    trackVerticalMarkdownImageNavigation,
} from "../../formats/markdown/editor/token-controller";
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
    readInlineFormatShortcut,
} from "./keyboard-shortcuts";
import {
    applyInlineFormatShortcut,
    deleteSelectedContent,
    replaceSelectionWithText,
} from "../selection/commands";

type EditorKeydownOptions = {
    isComposingText: boolean;
    markEditorDirty: () => void;
};

export function handleEditorKeydown(event: KeyboardEvent, options: EditorKeydownOptions): void {
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

    if (handleBlockMarkdownSourceKeydown(event)) {
        return;
    }

    const inlineFormat = readInlineFormatShortcut(event);
    if (inlineFormat) {
        event.preventDefault();
        if (applyInlineFormatShortcut(block, inlineFormat)) {
            options.markEditorDirty();
        }
        return;
    }

    if (moveCaretOutOfActiveMarkdownTokenSource(event, block)) {
        event.preventDefault();
        return;
    }

    if (trackVerticalBlockSourceNavigation(event, block)) {
        return;
    }
    trackHorizontalMarkdownNavigation(event);
    trackVerticalLeadingTokenNavigation(event, block);
    if (trackVerticalMarkdownImageNavigation(event, block)) {
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

        if (startCodeBlockFromFence(targetBlock)) {
            options.markEditorDirty();
            return;
        }

        if (startTableFromHeader(targetBlock)) {
            options.markEditorDirty();
            return;
        }

        if (moveCaretAfterCodeBlockSourceAtSelection(targetBlock)) {
            options.markEditorDirty();
            return;
        }

        if (isMultilinePlainTextBlockType(readBlockType(targetBlock.dataset.type)) && !event.ctrlKey && !event.metaKey) {
            replaceSelectionWithText(targetBlock, "\n");
            options.markEditorDirty();
            return;
        }

        if (insertLineBreakInOpenCodeFenceParagraph(targetBlock)) {
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

        if (moveCaretIntoCodeBlockSourceAtBoundary(event, block)) {
            event.preventDefault();
            return;
        }

        if (event.key === "Backspace" && removeTrailingLineBreakInMultilinePlainTextBlock(block)) {
            event.preventDefault();
            options.markEditorDirty();
            return;
        }

        if (event.key === "Backspace" && removeTrailingLineBreakInOpenCodeFenceParagraph(block)) {
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
