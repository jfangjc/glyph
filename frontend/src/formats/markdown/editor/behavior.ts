import { savePastedImage } from "../../../bridge/documents";
import {
    applyInlineFormatShortcut,
    deleteSelectedContent,
    replaceSelectionWithText,
} from "../../../editor/selection/commands";
import {
    focusBlockAtOffset,
    focusPlainTextElement,
    getActiveBlock,
    getCurrentBlockOffset,
    getSelectedBlockRange,
    isCaretAtBlockEdge,
    selectEditorContents,
} from "../../../editor/selection/caret";
import {
    commitTransientBlock,
    getBlockText,
    getSiblingBlock,
    isMultilinePlainTextBlockType,
    rerenderInlineBlockContent,
    rerenderPlainTextBlockContent,
    setBlockText,
} from "../../../editor/blocks/view";
import { readBlockType } from "../../../editor/blocks/model";
import {
    indentListBlocks,
    insertPastedText,
    mergeForward,
    removeOrMergeBackward,
    removeTrailingLineBreakInMultilinePlainTextBlock,
    splitBlock,
} from "../../../editor/blocks/operations";
import { getElement } from "../../../utils/dom";
import {
    isCompositionEvent,
    isPlainTextKey,
    isSelectAllShortcut,
    readInlineFormatShortcut,
} from "../../../editor/input/keyboard-shortcuts";
import type {
    DocumentEditorBehavior,
    DocumentEditorEventContext,
    DocumentEditorHooks,
    DocumentPasteContext,
} from "../../types";
import {
    applyMarkdownShortcut,
    completeCodeBlockFromFencedParagraph,
    insertLineBreakInOpenCodeFenceParagraph,
    removeTrailingLineBreakInOpenCodeFenceParagraph,
    startCodeBlockFromFence,
    startTableFromHeader,
} from "./block-operations";
import {
    applyFocusedBlockMarkdownSourceInput,
    commitActiveBlockMarkdownSource,
    configureMarkdownSourceController,
    getFocusedBlockMarkdownSource,
    handleBlockMarkdownSourceKeydown,
    moveCaretAfterCodeBlockSourceAtSelection,
    moveCaretIntoCodeBlockSourceAtBoundary,
    rerenderPlainTextBlockMarkdownSource,
    syncActiveBlockMarkdownSource,
    trackVerticalBlockSourceNavigation,
} from "./source-controller";
import {
    activateMarkdownTokenAtCaret,
    configureMarkdownTokenController,
    getFocusedMarkdownTokenSource,
    handleEditorClick as handleMarkdownEditorClick,
    handleEditorMouseDown as handleMarkdownEditorMouseDown,
    handleSelectionChange as handleMarkdownSelectionChange,
    moveCaretAfterActiveDisplayMathTokenSource,
    moveCaretOutOfActiveMarkdownTokenSource,
    normalizeActiveMarkdownTokenSource,
    suppressAdjacentFormatTokenActivation,
    trackHorizontalMarkdownNavigation,
    trackVerticalLeadingTokenNavigation,
    trackVerticalMarkdownImageNavigation,
} from "./token-controller";

export const markdownEditorBehavior: DocumentEditorBehavior = {
    install: installMarkdownEditorBehavior,
    beforeInput: handleMarkdownBeforeInput,
    input: handleMarkdownInput,
    keydown: handleMarkdownKeydown,
    mouseDown: handleMarkdownEditorMouseDown,
    click: (event) => {
        handleMarkdownEditorClick(event);
        return true;
    },
    selectionChange: () => {
        handleMarkdownSelectionChange();
        return true;
    },
    paste: handleMarkdownPaste,
    beforeSerialize: commitActiveBlockMarkdownSource,
};

function installMarkdownEditorBehavior(hooks: DocumentEditorHooks): void {
    configureMarkdownSourceController({
        markEditorDirty: hooks.markEditorDirty,
        syncBlockMarkdownSourceReveal: hooks.syncBlockSourceReveal,
    });
    configureMarkdownTokenController({
        syncActiveBlockIndicator: hooks.syncActiveBlockIndicator,
        syncActiveBlockMarkdownSource,
        syncBlockMarkdownSourceReveal: hooks.syncBlockSourceReveal,
    });
}

function handleMarkdownBeforeInput(event: InputEvent, context: DocumentEditorEventContext): boolean {
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

function handleMarkdownInput(event: Event, context: DocumentEditorEventContext): boolean {
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

function handleMarkdownKeydown(event: KeyboardEvent, context: DocumentEditorEventContext): boolean {
    const editor = getElement<HTMLElement>("editor");

    if (isCompositionEvent(event, context.isComposingText)) {
        return true;
    }

    if (isSelectAllShortcut(event)) {
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

    const inlineFormat = readInlineFormatShortcut(event);
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

    if (moveCaretAfterActiveDisplayMathTokenSource(event, block)) {
        event.preventDefault();
        return true;
    }

    if (trackVerticalBlockSourceNavigation(event, block)) {
        return true;
    }
    trackHorizontalMarkdownNavigation(event);
    trackVerticalLeadingTokenNavigation(event, block);
    if (trackVerticalMarkdownImageNavigation(event, block)) {
        return true;
    }

    if (event.key === "Tab" && indentListBlocks(block, event.shiftKey ? -1 : 1)) {
        event.preventDefault();
        context.markEditorDirty();
        return true;
    }

    if (event.key === "Enter") {
        event.preventDefault();
        const targetBlock = deleteSelectedContent() ?? block;

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

        if (event.key === "Backspace" && removeOrMergeBackward(block)) {
            event.preventDefault();
            context.markEditorDirty();
            return true;
        }

        if (event.key === "Delete" && mergeForward(block)) {
            event.preventDefault();
            context.markEditorDirty();
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

async function handleMarkdownPaste(event: ClipboardEvent, context: DocumentPasteContext): Promise<boolean> {
    const block = getActiveBlock(event.target);
    const image = readClipboardImage(event.clipboardData);

    if (!image || !block) {
        return false;
    }

    event.preventDefault();

    let activeFilePath = context.getActiveFilePath();
    if (!activeFilePath) {
        const saved = await context.ensureDocumentSaved();
        if (!saved) {
            return true;
        }

        activeFilePath = context.getActiveFilePath();
    }

    if (!activeFilePath) {
        return true;
    }

    try {
        const dataUrl = await readFileAsDataUrl(image);
        const pastedImage = await savePastedImage(activeFilePath, dataUrl, image.name, image.type);
        commitTransientBlock(block);
        insertPastedText(block, `![${escapeMarkdownImageAlt(image.name)}](${pastedImage.relativePath})`);
        context.markEditorDirty();
    } catch (error) {
        console.error("Failed to paste image:", error);
    }

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

function readClipboardImage(dataTransfer: DataTransfer | null | undefined): File | null {
    if (!dataTransfer) {
        return null;
    }

    for (const item of Array.from(dataTransfer.items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
            return item.getAsFile();
        }
    }

    return Array.from(dataTransfer.files).find((file) => file.type.startsWith("image/")) ?? null;
}

function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => {
            if (typeof reader.result === "string") {
                resolve(reader.result);
            } else {
                reject(new Error("Unable to read image data"));
            }
        });
        reader.addEventListener("error", () => reject(reader.error ?? new Error("Unable to read image data")));
        reader.readAsDataURL(file);
    });
}

function escapeMarkdownImageAlt(value: string): string {
    return value.replace(/\.[^/.\\]+$/, "").replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}
