import {
    applyInlineFormatShortcut,
    deleteSelectedContent,
    replaceSelectionWithText,
} from "../../../editor/selection/commands";
import {
    getActiveBlock,
    getSelectedBlockRange,
    isCaretAtBlockEdge,
    selectEditorContents,
} from "../../../editor/selection/caret";
import {
    getSiblingBlock,
    isMultilinePlainTextBlockType,
} from "../../../editor/blocks/view";
import { readBlockType } from "../../../editor/blocks/model";
import {
    deleteBlockBoundary,
    indentListBlocks,
    removeTrailingLineBreakInMultilinePlainTextBlock,
    splitBlock,
} from "../../../editor/blocks/operations";
import { readEditorDom } from "../../../editor/editor-dom";
import {
    matchesShortcutCommand,
    readInlineFormatShortcut,
} from "../../../app/keymap";
import {
    isCompositionEvent,
    isPlainTextKey,
} from "../../../editor/input/keyboard-events";
import type { DocumentEditorEventContext } from "../../types";
import {
    insertLineBreakInOpenCodeFenceParagraph,
    insertParagraphBeforeHeadingAtStart,
    removeTrailingLineBreakInOpenCodeFenceParagraph,
    splitParagraphAtHeadingMarker,
    startCodeBlockFromFence,
    startTableFromHeader,
} from "./block-operations";
import {
    deleteHeadingPrefixCharacterAtBoundary,
    handleBlockMarkdownSourceKeydown,
    moveCaretAfterCodeBlockSourceAtSelection,
    moveCaretIntoCodeBlockSourceAtBoundary,
} from "./source-controller";
import {
    moveCaretAfterActiveDisplayMathTokenSource,
    moveCaretOutOfActiveMarkdownTokenSource,
    moveCaretOutOfActiveMarkdownTokenSourceVertically,
} from "./token-controller";

export function handleMarkdownKeydown(event: KeyboardEvent, context: DocumentEditorEventContext): boolean {
    const { editor } = readEditorDom();

    if (isCompositionEvent(event, context.isComposingText)) {
        return true;
    }

    if (matchesShortcutCommand(event, "edit:select-all", "markdown")) {
        event.preventDefault();
        selectEditorContents(editor);
        return true;
    }

    const block = getActiveBlock(event.target);
    if (!block) {
        return false;
    }

    if (handleBlockMarkdownSourceKeydown(event)) {
        return true;
    }

    const inlineFormat = readInlineFormatShortcut(event, "markdown");
    if (inlineFormat) {
        event.preventDefault();
        if (applyInlineFormatShortcut(block, inlineFormat)) {
            context.markEditorDirty();
        }
        return true;
    }

    if (moveCaretOutOfActiveMarkdownTokenSource(event, block)) {
        event.preventDefault();
        return true;
    }

    if (moveCaretOutOfActiveMarkdownTokenSourceVertically(event, block)) {
        return true;
    }

    if (moveCaretAfterActiveDisplayMathTokenSource(event, block)) {
        event.preventDefault();
        return true;
    }

    if (event.key === "Tab" && indentListBlocks(block, event.shiftKey ? -1 : 1)) {
        event.preventDefault();
        context.markEditorDirty();
        return true;
    }

    if (event.key === "Enter") {
        event.preventDefault();
        const targetBlock = deleteSelectedContent()?.block ?? block;

        if (insertParagraphBeforeHeadingAtStart(targetBlock)) {
            context.markEditorDirty();
            return true;
        }

        if (startCodeBlockFromFence(targetBlock)) {
            context.markEditorDirty();
            return true;
        }

        if (startTableFromHeader(targetBlock)) {
            context.markEditorDirty();
            return true;
        }

        if (moveCaretAfterCodeBlockSourceAtSelection(targetBlock)) {
            context.markEditorDirty();
            return true;
        }

        if (isMultilinePlainTextBlockType(readBlockType(targetBlock.dataset.type)) && !event.ctrlKey && !event.metaKey) {
            replaceSelectionWithText(targetBlock, "\n");
            context.markEditorDirty();
            return true;
        }

        if (insertLineBreakInOpenCodeFenceParagraph(targetBlock)) {
            context.markEditorDirty();
            return true;
        }

        if (splitParagraphAtHeadingMarker(targetBlock)) {
            context.markEditorDirty();
            return true;
        }

        splitBlock(targetBlock);
        context.markEditorDirty();
        return true;
    }

    if (event.key === "Backspace" || event.key === "Delete") {
        if (
            readBlockType(block.dataset.type) === "source" &&
            event.key === "Backspace" &&
            isCaretAtBlockEdge(block, "start")
        ) {
            event.preventDefault();
            return true;
        }

        if (
            event.key === "Backspace" &&
            readBlockType(block.dataset.type) === "paragraph" &&
            isCaretAtBlockEdge(block, "start") &&
            !getSiblingBlock(block, "previous")
        ) {
            event.preventDefault();
            return true;
        }

        if (
            event.key === "Delete" &&
            readBlockType(block.dataset.type) !== "code" &&
            isCaretAtBlockEdge(block, "end") &&
            !getSiblingBlock(block, "next")
        ) {
            event.preventDefault();
            return true;
        }

        if (deleteSelectedContent()) {
            event.preventDefault();
            context.markEditorDirty();
            return true;
        }

        if (deleteHeadingPrefixCharacterAtBoundary(event, block)) {
            event.preventDefault();
            context.markEditorDirty();
            return true;
        }

        if (moveCaretIntoCodeBlockSourceAtBoundary(event, block)) {
            event.preventDefault();
            return true;
        }

        if (event.key === "Backspace" && removeTrailingLineBreakInMultilinePlainTextBlock(block)) {
            event.preventDefault();
            context.markEditorDirty();
            return true;
        }

        if (event.key === "Backspace" && removeTrailingLineBreakInOpenCodeFenceParagraph(block)) {
            event.preventDefault();
            context.markEditorDirty();
            return true;
        }

        const boundaryDelete =
            event.key === "Backspace"
                ? deleteBlockBoundary(block, "previous")
                : deleteBlockBoundary(block, "next");
        if (boundaryDelete) {
            event.preventDefault();
            if (boundaryDelete === "changed") {
                context.markEditorDirty();
            }
            return true;
        }
    }

    if (isPlainTextKey(event) && getSelectedBlockRange()) {
        event.preventDefault();
        replaceSelectionWithText(block, event.key);
        context.markEditorDirty();
    }

    return true;
}
