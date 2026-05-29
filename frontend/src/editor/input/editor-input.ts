import {
    applyMarkdownShortcut,
    completeCodeBlockFromFencedParagraph,
} from "../../formats/markdown/editor/block-operations";
import {
    applyFocusedBlockMarkdownSourceInput,
    getFocusedBlockMarkdownSource,
    rerenderPlainTextBlockMarkdownSource,
} from "../../formats/markdown/editor/source-controller";
import {
    activateMarkdownTokenAtCaret,
    getFocusedMarkdownTokenSource,
    normalizeActiveMarkdownTokenSource,
    suppressAdjacentFormatTokenActivation,
} from "../../formats/markdown/editor/token-controller";
import {
    commitTransientBlock,
    getBlockText,
    rerenderInlineBlockContent,
    rerenderPlainTextBlockContent,
    setBlockText,
} from "../blocks/view";
import { readBlockType } from "../blocks/model";
import {
    focusBlockAtOffset,
    focusPlainTextElement,
    getActiveBlock,
    getCurrentBlockOffset,
} from "../selection/caret";
import { isCompositionEvent } from "./keyboard-shortcuts";

type EditorInputOptions = {
    isComposingText: boolean;
    markDocumentDirty: () => void;
    markEditorDirty: () => void;
    syncBlockSourceReveal: (block: HTMLElement | null) => void;
};

export function handleEditorBeforeInput(event: InputEvent, options: EditorInputOptions): void {
    const source = getFocusedBlockMarkdownSource();
    if (source && source.textContent === "" && event.inputType === "insertText" && event.data) {
        event.preventDefault();
        source.textContent = event.data;
        focusPlainTextElement(source, event.data.length);
        applyFocusedBlockMarkdownSourceInput(source);
        options.markEditorDirty();
        return;
    }

    const block = getActiveBlock(event.target);
    if (!block || event.inputType !== "insertText" || !event.data || readBlockType(block.dataset.type) !== "paragraph") {
        return;
    }

    const text = getBlockText(block);
    if (!text.endsWith("\n") || getCurrentBlockOffset(block) !== text.length) {
        return;
    }

    event.preventDefault();
    setBlockText(block, text + event.data);
    focusBlockAtOffset(block, text.length + event.data.length, { scroll: "none" });
    completeFencedParagraph(block, options);
    options.markEditorDirty();
}

export function handleEditorInput(event: Event, options: EditorInputOptions): void {
    const block = getActiveBlock(event.target);
    if (!block) {
        return;
    }

    commitTransientBlock(block);

    if (isCompositionEvent(event, options.isComposingText)) {
        options.markDocumentDirty();
        return;
    }

    const blockMarkdownSource = getFocusedBlockMarkdownSource();
    if (blockMarkdownSource) {
        applyFocusedBlockMarkdownSourceInput(blockMarkdownSource);
        options.markEditorDirty();
        return;
    }

    if (getFocusedMarkdownTokenSource()) {
        normalizeActiveMarkdownTokenSource(block);
        options.markEditorDirty();
        return;
    }

    if (rerenderPlainTextBlockMarkdownSource(block)) {
        options.markEditorDirty();
        return;
    }

    if (renderPlainTextBlockContent(block, getCurrentBlockOffset(block))) {
        options.markEditorDirty();
        return;
    }

    if (!completeFencedParagraph(block, options) && !applyMarkdownShortcut(block)) {
        renderBlockContent(block, getCurrentBlockOffset(block));
    }

    options.markEditorDirty();
}

function completeFencedParagraph(block: HTMLElement, options: EditorInputOptions): boolean {
    if (!completeCodeBlockFromFencedParagraph(block)) {
        return false;
    }

    options.syncBlockSourceReveal(block);
    return true;
}

function renderBlockContent(block: HTMLElement, currentOffset: number): void {
    const focusOffset = rerenderInlineBlockContent(block, currentOffset);

    if (focusOffset === null) {
        return;
    }

    focusBlockAtOffset(block, focusOffset);
    if (!suppressAdjacentFormatTokenActivation(block, focusOffset)) {
        activateMarkdownTokenAtCaret();
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
