import {
    focusBlockAtOffset,
    getActiveBlock,
    getCurrentBlockOffset,
} from "../../../editor/selection/caret";
import {
    applyBlockProperties,
    commitTransientBlock,
    getBlockText,
    readBlockListMarker,
    rerenderInlineBlockContent,
    rerenderPlainTextBlockContent,
    setBlockText,
} from "../../../editor/blocks/view";
import { readBlockType } from "../../../editor/blocks/model";
import { resetEmptyBlockAfterDeleteInput } from "../../../editor/blocks/operations";
import { isCompositionEvent } from "../../../editor/input/keyboard-events";
import type { DocumentEditorEventContext } from "../../types";
import {
    applyMarkdownShortcut,
    completeCodeBlockFromFencedParagraph,
} from "./block-operations";
import {
    applyFocusedBlockMarkdownSourceInput,
    ensureActiveBlockMarkdownSource,
    getDirectlyFocusedBlockMarkdownSource,
    getFocusedBlockMarkdownSource,
    insertTextIntoFocusedBlockMarkdownSource,
    rerenderPlainTextBlockMarkdownSource,
} from "./source-controller";
import {
    getFocusedMarkdownTokenSource,
    moveCaretOutOfInactiveMarkdownTokenSourceBoundary,
    normalizeActiveMarkdownTokenSource,
    revealMarkdownTokenAtCaret,
    suppressAdjacentFormatTokenActivation,
} from "./token-controller";

export function handleMarkdownBeforeInput(event: InputEvent, context: DocumentEditorEventContext): boolean {
    const source = getFocusedBlockMarkdownSource();
    ensureActiveBlockMarkdownSource(source);
    if (source && event.inputType === "insertText" && event.data && !context.isComposingText) {
        event.preventDefault();
        if (insertTextIntoFocusedBlockMarkdownSource(event.data)) {
            context.markEditorDirty();
        }
        return true;
    }

    const block = getActiveBlock(event.target);
    if (!block || event.inputType !== "insertText" || !event.data || readBlockType(block.dataset.type) !== "paragraph") {
        return false;
    }

    const text = getBlockText(block);
    if (!text.endsWith("\n") || getCurrentBlockOffset(block) !== text.length) {
        return false;
    }

    event.preventDefault();
    setBlockText(block, text + event.data);
    focusBlockAtOffset(block, text.length + event.data.length, { scroll: "none" });
    completeFencedParagraph(block, context);
    context.markEditorDirty();
    return true;
}

export function handleMarkdownInput(event: Event, context: DocumentEditorEventContext): boolean {
    const block = getActiveBlock(event.target);
    if (!block) {
        return false;
    }

    commitTransientBlock(block);

    if (isCompositionEvent(event, context.isComposingText)) {
        context.markDocumentDirty();
        return true;
    }

    const blockMarkdownSource = getDirectlyFocusedBlockMarkdownSource();
    if (blockMarkdownSource) {
        applyFocusedBlockMarkdownSourceInput(blockMarkdownSource);
        context.markEditorDirty();
        return true;
    }

    if (getFocusedMarkdownTokenSource()) {
        normalizeActiveMarkdownTokenSource(block);
        context.markEditorDirty();
        return true;
    }

    if (completeTodoShortcutFromActiveList(block)) {
        context.markEditorDirty();
        return true;
    }

    if (restoreEmptyActiveListSourceBlock(block, event)) {
        context.markEditorDirty();
        return true;
    }

    if (resetEmptyBlockAfterDeleteInput(block, event)) {
        context.markEditorDirty();
        return true;
    }

    if (rerenderPlainTextBlockMarkdownSource(block)) {
        context.markEditorDirty();
        return true;
    }

    if (renderPlainTextBlockContent(block, getCurrentBlockOffset(block))) {
        context.markEditorDirty();
        return true;
    }

    if (!completeFencedParagraph(block, context) && !applyMarkdownShortcut(block)) {
        renderInlineBlockContent(block, getCurrentBlockOffset(block));
    }

    context.markEditorDirty();
    return true;
}

function completeFencedParagraph(block: HTMLElement, context: DocumentEditorEventContext): boolean {
    if (!completeCodeBlockFromFencedParagraph(block)) {
        return false;
    }

    context.syncBlockSourceReveal(block);
    return true;
}

function completeTodoShortcutFromActiveList(block: HTMLElement): boolean {
    if (readBlockType(block.dataset.type) !== "list" || block.dataset.blockSourceActive !== "true") {
        return false;
    }

    const text = getBlockText(block);
    const match = text.match(/^\[([ xX])\]\s+(.*)$/);
    if (!match) {
        return false;
    }

    const caretOffset = getCurrentBlockOffset(block);
    const bodyText = match[2];
    const markerLength = text.length - bodyText.length;

    applyBlockProperties(block, {
        type: "todo",
        checked: match[1].toLowerCase() === "x",
        listMarker: readBlockListMarker(block),
    });
    setBlockText(block, bodyText);
    focusBlockAtOffset(block, Math.max(0, caretOffset - markerLength), { scroll: "none" });
    return true;
}

function restoreEmptyActiveListSourceBlock(block: HTMLElement, event: Event): boolean {
    if (!(event instanceof InputEvent) || !event.inputType.startsWith("delete")) {
        return false;
    }

    const type = readBlockType(block.dataset.type);
    if (type !== "list" && type !== "ordered-list" && type !== "todo") {
        return false;
    }

    if (block.dataset.blockSourceActive !== "true" || getBlockText(block) !== "") {
        return false;
    }

    setBlockText(block, "");
    focusBlockAtOffset(block, 0, { scroll: "none" });
    return true;
}

function renderInlineBlockContent(block: HTMLElement, currentOffset: number): void {
    const focusOffset = rerenderInlineBlockContent(block, currentOffset);

    if (focusOffset === null) {
        return;
    }

    focusBlockAtOffset(block, focusOffset);
    if (moveCaretOutOfInactiveMarkdownTokenSourceBoundary(block, focusOffset)) {
        return;
    }

    if (!suppressAdjacentFormatTokenActivation(block, focusOffset)) {
        revealMarkdownTokenAtCaret();
    }
}

function renderPlainTextBlockContent(block: HTMLElement, currentOffset: number): boolean {
    const focusOffset = rerenderPlainTextBlockContent(block, currentOffset);
    if (focusOffset === null) {
        return false;
    }

    focusBlockAtOffset(block, focusOffset);
    return true;
}
