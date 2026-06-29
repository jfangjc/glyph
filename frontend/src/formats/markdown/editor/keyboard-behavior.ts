import {
    applyInlineFormatShortcut,
    deleteSelectedContent,
    replaceSelectionWithText,
} from "../../../editor/selection/commands";
import {
    getActiveBlock,
    getCurrentBlockOffset,
    getSelectedBlockRange,
    isCaretAtBlockEdge,
    focusBlockAtOffset,
    focusPlainTextElement,
    selectEditorContents,
} from "../../../editor/selection/caret";
import {
    getBlockContent,
    getSiblingBlock,
    getBlockText,
    isMultilinePlainTextBlockType,
    setBlockText,
} from "../../../editor/blocks/view";
import { readBlockType } from "../../../editor/blocks/model";
import { getBlockSourceElement } from "../../../editor/blocks/rendering";
import {
    deleteBlockBoundary,
    indentListBlocks,
    removeEmptyBlockBackward,
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
    deletePrefixBlockMarkdownSourceCharacter,
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

    if (moveCaretIntoPrefixSourceFromBodyStart(event, block)) {
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

        if (deletePrefixSourceBackwardFromBodyStart(event, block)) {
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

        if (event.key === "Backspace" && deleteFinalCharacterInActiveListSourceBlock(block)) {
            event.preventDefault();
            context.markEditorDirty();
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

        if (event.key === "Backspace" && removeEmptyActiveListSourceBlockBackward(block)) {
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

function deleteFinalCharacterInActiveListSourceBlock(block: HTMLElement): boolean {
    if (!isActiveListSourceBlock(block)) {
        return false;
    }

    const text = getBlockText(block);
    if (text.length !== 1 || getCurrentBlockOffset(block) !== text.length) {
        return false;
    }

    setBlockText(block, "");
    focusBlockAtOffset(block, 0, { scroll: "none" });
    return true;
}

function moveCaretIntoPrefixSourceFromBodyStart(event: KeyboardEvent, block: HTMLElement): boolean {
    if (
        event.key !== "ArrowLeft" ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        getCurrentBlockOffset(block) !== 0
    ) {
        return false;
    }

    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    const source = getBlockSourceElement(getBlockContent(block), "prefix");
    if (!selection?.isCollapsed || !focusNode || !source || source.contains(focusNode)) {
        return false;
    }

    block.dataset.blockSourceActive = "true";
    focusPlainTextElement(source, readPrefixSourceEntryOffset(source));
    return true;
}

function readPrefixSourceEntryOffset(source: HTMLElement): number {
    return Math.max(0, (source.textContent?.length ?? 0) - 1);
}

function deletePrefixSourceBackwardFromBodyStart(event: KeyboardEvent, block: HTMLElement): boolean {
    if (
        event.key !== "Backspace" ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        block.dataset.blockSourceActive !== "true" ||
        getCurrentBlockOffset(block) !== 0
    ) {
        return false;
    }

    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    const source = getBlockSourceElement(getBlockContent(block), "prefix");
    if (!selection?.isCollapsed || !focusNode || !source || source.contains(focusNode)) {
        return false;
    }

    return deletePrefixBlockMarkdownSourceCharacter(source);
}

function removeEmptyActiveListSourceBlockBackward(block: HTMLElement): boolean {
    if (!isActiveListSourceBlock(block)) {
        return false;
    }

    return removeEmptyBlockBackward(block) === "changed";
}

function isActiveListSourceBlock(block: HTMLElement): boolean {
    const type = readBlockType(block.dataset.type);
    if (type !== "list" && type !== "ordered-list" && type !== "todo") {
        return false;
    }

    return block.dataset.blockSourceActive === "true";
}
