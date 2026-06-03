import {
    focusBlockAtOffset,
    focusPlainTextElement,
    getActiveBlock,
    getCurrentBlockOffset,
} from "../../../editor/selection/caret";
import {
    commitTransientBlock,
    getBlockText,
    rerenderInlineBlockContent,
    rerenderPlainTextBlockContent,
    setBlockText,
} from "../../../editor/blocks/view";
import { readBlockType } from "../../../editor/blocks/model";
import { isCompositionEvent } from "../../../editor/input/keyboard-shortcuts";
import type { DocumentEditorEventContext } from "../../types";
import {
    applyMarkdownShortcut,
    completeCodeBlockFromFencedParagraph,
} from "./block-operations";
import {
    applyFocusedBlockMarkdownSourceInput,
    getFocusedBlockMarkdownSource,
    rerenderPlainTextBlockMarkdownSource,
} from "./source-controller";
import {
    getFocusedMarkdownTokenSource,
    normalizeActiveMarkdownTokenSource,
    revealMarkdownTokenAtCaret,
    suppressAdjacentFormatTokenActivation,
} from "./token-controller";

export function handleMarkdownBeforeInput(event: InputEvent, context: DocumentEditorEventContext): boolean {
    const source = getFocusedBlockMarkdownSource();
    if (source && source.textContent === "" && event.inputType === "insertText" && event.data) {
        event.preventDefault();
        source.textContent = event.data;
        focusPlainTextElement(source, event.data.length);
        applyFocusedBlockMarkdownSourceInput(source);
        context.markEditorDirty();
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

    const blockMarkdownSource = getFocusedBlockMarkdownSource();
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

function renderInlineBlockContent(block: HTMLElement, currentOffset: number): void {
    const focusOffset = rerenderInlineBlockContent(block, currentOffset);

    if (focusOffset === null) {
        return;
    }

    focusBlockAtOffset(block, focusOffset);
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
