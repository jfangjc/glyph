import { Window } from "@wailsio/runtime";
import { parseMarkdownDocument, serializeMarkdownDocument } from "../formats/markdown/document";
import { parseMarkdownReferenceDefinition, type MarkdownReferenceMap } from "../formats/markdown/references";
import type { DocumentFile } from "../bridge/types";
import {
    bindDocumentActions,
    canUseDesktopFileSystem,
    openDocument,
    saveCurrentDocument,
    startDocumentAutosave,
} from "../documents/document-actions";
import {
    documentState,
    documentStateChangedEvent,
    markDocumentDirty,
    notifyDocumentStateChanged,
} from "../documents/document-state";
import {
    applyMarkdownShortcut,
    completeCodeBlockFromFencedParagraph,
    indentListBlocks,
    insertLineBreakInOpenCodeFenceParagraph,
    insertPastedText,
    mergeForward,
    removeOrMergeBackward,
    removeTrailingLineBreakInCodeBlock,
    removeTrailingLineBreakInOpenCodeFenceParagraph,
    splitBlock,
    startCodeBlockFromFence,
} from "./block-operations";
import {
    commitTransientBlock,
    configureBlockView,
    createBlock,
    findBlock,
    getBlockText,
    getEditorBlocks,
    getSerializableEditorBlocks,
    hasBlockMarkdownSource,
    isInlineMarkdownBlockType,
    readEditorBlock,
    rerenderInlineBlockContent,
    setBlockText,
    syncFirstBlockPlaceholder,
} from "./block-view";
import { readBlockType, type ParsedBlock } from "./block-model";
import {
    configureCaret,
    focusBlockAtOffset,
    focusPlainTextElement,
    getActiveBlock,
    getCurrentBlockOffset,
    getSelectedBlockRange,
    selectEditorContents,
} from "./caret";
import { getElement } from "./dom-utils";
import {
    isCompositionEvent,
    isOpenFileShortcut,
    isPlainTextKey,
    isSaveFileShortcut,
    isSelectAllShortcut,
    readInlineFormatShortcut,
    readZoomShortcut,
    type ZoomShortcut,
} from "./keyboard-shortcuts";
import {
    applyInlineFormatShortcut,
    deleteSelectedContent,
    readSelectedMarkdown,
    replaceSelectionWithText,
} from "./selection-commands";
import {
    clearGutterHoverBlock,
    clearLinkOpenIntent,
    configurePointerInteractions,
    handleDocumentMouseMove,
    handleDocumentMouseUp,
    handleDocumentSurfaceMouseDown,
    handleDocumentSurfaceMouseMove,
    handleDocumentSurfaceMouseOut,
    handleDocumentSurfaceMouseOver,
    handleEditorMouseDown,
    syncLinkOpenIntentFromKeyboard,
} from "./pointer-interactions";
import {
    activateMarkdownTokenAtCaret,
    configureMarkdownTokenController,
    getFocusedMarkdownTokenSource,
    handleEditorClick,
    handleSelectionChange,
    moveCaretOutOfActiveMarkdownTokenSource,
    normalizeActiveMarkdownTokenSource,
    suppressAdjacentFormatTokenActivation,
    trackHorizontalMarkdownNavigation,
    trackVerticalLeadingTokenNavigation,
    trackVerticalMarkdownImageNavigation,
} from "./markdown-token-controller";
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
} from "./markdown-source-controller";
import { clamp, fileNameFromPath } from "./text-utils";

let markdownReferences: MarkdownReferenceMap = {};
let indicatedActiveBlock: HTMLElement | null = null;
let markdownSourceRevealBlocks: HTMLElement[] = [];
let isComposingText = false;
let browserPreviewZoom = 1;

export function installEditorController(): void {
    const surface = getElement<HTMLElement>("document-surface");
    const editor = getElement<HTMLElement>("editor");
    const title = getElement<HTMLInputElement>("document-title");

    surface.addEventListener("mousedown", handleDocumentSurfaceMouseDown);
    surface.addEventListener("mousemove", handleDocumentSurfaceMouseMove);
    surface.addEventListener("mouseleave", clearGutterHoverBlock);
    surface.addEventListener("mouseover", handleDocumentSurfaceMouseOver);
    surface.addEventListener("mouseout", handleDocumentSurfaceMouseOut);
    document.addEventListener("mousemove", handleDocumentMouseMove);
    document.addEventListener("mouseup", handleDocumentMouseUp);
    editor.addEventListener("keydown", handleEditorKeydown);
    editor.addEventListener("mousedown", handleEditorMouseDown);
    editor.addEventListener("beforeinput", handleEditorBeforeInput);
    editor.addEventListener("input", handleEditorInput);
    editor.addEventListener("copy", handleEditorCopy);
    editor.addEventListener("cut", handleEditorCut);
    editor.addEventListener("paste", handleEditorPaste);
    editor.addEventListener("change", handleEditorChange);
    editor.addEventListener("click", handleEditorClick);
    editor.addEventListener("compositionstart", handleEditorCompositionStart);
    editor.addEventListener("compositionend", handleEditorCompositionEnd);
    title.addEventListener("input", handleTitleInput);
    title.addEventListener("focus", () => {
        syncActiveBlockIndicator(null);
        syncBlockMarkdownSourceReveal(null);
    });
    document.addEventListener("selectionchange", handleSelectionChange);
    window.addEventListener("keydown", handleGlobalKeydown);
    window.addEventListener("keyup", syncLinkOpenIntentFromKeyboard);
    window.addEventListener("blur", clearLinkOpenIntent);
    window.addEventListener(documentStateChangedEvent, handleDocumentStateChanged);
    configureCaret({
        onBlockFocused: (block) => {
            syncActiveBlockIndicator(block);
            syncBlockMarkdownSourceReveal(block);
        },
    });
    configurePointerInteractions({
        onBlockActivated: syncActiveBlockIndicator,
    });
    configureMarkdownSourceController({
        markEditorDirty,
        syncBlockMarkdownSourceReveal,
    });
    configureMarkdownTokenController({
        syncActiveBlockIndicator,
        syncActiveBlockMarkdownSource,
        syncBlockMarkdownSourceReveal,
    });
    bindDocumentActions({ loadDocument, serializeDocumentMarkdown });
    startDocumentAutosave();

    syncBlockViewContext();
    syncFirstBlockPlaceholder();
    syncDocumentWindowTitle();
}

function handleDocumentStateChanged(): void {
    syncBlockViewContext();
    syncDocumentWindowTitle();
}

function syncBlockViewContext(): void {
    configureBlockView({
        markdownReferences,
        activeFilePath: documentState.activeFilePath,
    });
}

function handleGlobalKeydown(event: KeyboardEvent): void {
    syncLinkOpenIntentFromKeyboard(event);

    const zoomShortcut = readZoomShortcut(event);
    if (zoomShortcut) {
        event.preventDefault();
        void applyZoomShortcut(zoomShortcut);
        return;
    }

    if (!canUseDesktopFileSystem()) {
        return;
    }

    if (isOpenFileShortcut(event)) {
        event.preventDefault();
        void openDocument();
        return;
    }

    if (isSaveFileShortcut(event)) {
        event.preventDefault();
        void saveDocumentFromEditor(event.shiftKey);
    }
}

async function applyZoomShortcut(shortcut: ZoomShortcut): Promise<void> {
    if (canUseDesktopFileSystem()) {
        try {
            if (shortcut === "in") {
                await Window.ZoomIn();
                return;
            }

            if (shortcut === "out") {
                await Window.ZoomOut();
                return;
            }

            await Window.ZoomReset();
            return;
        } catch (error) {
            console.error("Failed to apply window zoom:", error);
        }
    }

    applyBrowserPreviewZoom(shortcut);
}

function applyBrowserPreviewZoom(shortcut: ZoomShortcut): void {
    if (shortcut === "reset") {
        browserPreviewZoom = 1;
    } else {
        browserPreviewZoom += shortcut === "in" ? 0.1 : -0.1;
    }

    browserPreviewZoom = clamp(browserPreviewZoom, 0.7, 1.6);
    document.documentElement.style.setProperty("--glyph-editor-zoom", browserPreviewZoom.toFixed(2));
}

async function saveDocumentFromEditor(promptForPath = false): Promise<void> {
    await saveCurrentDocument({
        promptForPath: promptForPath || !documentState.activeFilePath,
        suggestedFileName: getSuggestedFileName(),
    });
}

function syncDocumentWindowTitle(): void {
    const fileName = documentState.activeFilePath
        ? fileNameFromPath(documentState.activeFilePath)
        : getSuggestedFileName();
    const status = readDocumentStatusLabel(canUseDesktopFileSystem());
    const title = status ? `${fileName} - ${status} - Glyph` : `${fileName} - Glyph`;

    document.title = title;

    if (canUseDesktopFileSystem()) {
        void Window.SetTitle(title).catch((error) => console.error("Failed to update window title:", error));
    }
}

function readDocumentStatusLabel(canUseFiles: boolean): string {
    if (!canUseFiles) {
        return documentState.hasUnsavedChanges ? "Unsaved preview" : "";
    }

    if (documentState.isSavingDocument) {
        return "Saving...";
    }

    if (documentState.isOpeningDocument) {
        return "Opening...";
    }

    if (documentState.hasUnsavedChanges) {
        return "Unsaved";
    }

    return documentState.activeFilePath ? "" : "Not saved";
}

function getSuggestedFileName(): string {
    const title = getElement<HTMLInputElement>("document-title").value.trim();
    const baseName = title || fileNameFromPath(documentState.activeFilePath ?? "") || "Untitled";
    const safeName = baseName
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
        .replace(/\s+/g, " ")
        .replace(/[. ]+$/g, "")
        .slice(0, 80)
        .trim();

    return safeName ? safeName : "Untitled";
}

function handleTitleInput(): void {
    documentState.usesTitle = true;
    markDocumentDirty();
}

function handleEditorChange(event: Event): void {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.classList.contains("todo-checkbox")) {
        const block = findBlock(target);
        if (block) {
            setBlockText(block, getBlockText(block));
        }

        syncActiveBlockIndicator(block);
        syncBlockMarkdownSourceReveal(block);
        markDocumentDirty();
    }
}

function loadDocument(documentFile: DocumentFile): void {
    const parsedDocument = parseMarkdownDocument(documentFile);
    const title = getElement<HTMLInputElement>("document-title");

    documentState.activeFilePath = documentFile.path;
    documentState.usesTitle = parsedDocument.usesTitle;
    markdownReferences = parsedDocument.references ?? {};
    syncBlockViewContext();
    title.value = parsedDocument.title;
    replaceEditorBlocks(parsedDocument.blocks);
    documentState.lastSavedMarkdown = serializeDocumentMarkdown();
    documentState.hasUnsavedChanges = false;
    notifyDocumentStateChanged();
}

function serializeDocumentMarkdown(): string {
    commitActiveBlockMarkdownSource();
    const title = getElement<HTMLInputElement>("document-title").value;
    return serializeMarkdownDocument(title, documentState.usesTitle, getSerializableEditorBlocks().map(readEditorBlock));
}

function markEditorDirty(): void {
    syncMarkdownReferences();
    markDocumentDirty();
}

function syncMarkdownReferences(): void {
    const nextReferences = readMarkdownReferences();
    if (JSON.stringify(nextReferences) === JSON.stringify(markdownReferences)) {
        return;
    }

    markdownReferences = nextReferences;
    syncBlockViewContext();
    rerenderInlineMarkdownBlocks();
}

function readMarkdownReferences(): MarkdownReferenceMap {
    const references: MarkdownReferenceMap = {};

    for (const block of getEditorBlocks()) {
        if (readBlockType(block.dataset.type) !== "reference") {
            continue;
        }

        const definition = parseMarkdownReferenceDefinition(getBlockText(block));
        if (definition) {
            references[definition.normalizedLabel] = definition.reference;
        }
    }

    return references;
}

function rerenderInlineMarkdownBlocks(): void {
    const selection = document.getSelection();
    const activeBlock = findBlock(selection?.focusNode ?? null);
    const activeOffset = activeBlock ? getCurrentBlockOffset(activeBlock) : null;

    for (const block of getEditorBlocks()) {
        if (isInlineMarkdownBlockType(readBlockType(block.dataset.type))) {
            setBlockText(block, getBlockText(block));
        }
    }

    if (activeBlock?.isConnected && activeOffset !== null) {
        focusBlockAtOffset(activeBlock, Math.min(activeOffset, getBlockText(activeBlock).length));
    }
}

function replaceEditorBlocks(blocks: ParsedBlock[]): void {
    const editor = getElement<HTMLElement>("editor");
    const nextBlocks = blocks.map((block) => createBlock(block.type, block.text, block));

    editor.replaceChildren(...nextBlocks);
    syncFirstBlockPlaceholder();
    focusBlockAtOffset(nextBlocks[0], 0);
}

function handleEditorKeydown(event: KeyboardEvent): void {
    const editor = getElement<HTMLElement>("editor");

    if (isCompositionEvent(event, isComposingText)) {
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
            markEditorDirty();
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
        markEditorDirty();
        return;
    }

    if (event.key === "Enter") {
        event.preventDefault();
        const targetBlock = deleteSelectedContent() ?? block;

        if (startCodeBlockFromFence(targetBlock)) {
            markEditorDirty();
            return;
        }

        if (moveCaretAfterCodeBlockSourceAtSelection(targetBlock)) {
            markEditorDirty();
            return;
        }

        if (readBlockType(targetBlock.dataset.type) === "code" && !event.ctrlKey && !event.metaKey) {
            replaceSelectionWithText(targetBlock, "\n");
            markEditorDirty();
            return;
        }

        if (insertLineBreakInOpenCodeFenceParagraph(targetBlock)) {
            markEditorDirty();
            return;
        }

        splitBlock(targetBlock);
        markEditorDirty();
        return;
    }

    if (event.key === "Backspace" || event.key === "Delete") {
        if (deleteSelectedContent()) {
            event.preventDefault();
            markEditorDirty();
            return;
        }

        if (moveCaretIntoCodeBlockSourceAtBoundary(event, block)) {
            event.preventDefault();
            return;
        }

        if (event.key === "Backspace" && removeTrailingLineBreakInCodeBlock(block)) {
            event.preventDefault();
            markEditorDirty();
            return;
        }

        if (event.key === "Backspace" && removeTrailingLineBreakInOpenCodeFenceParagraph(block)) {
            event.preventDefault();
            markEditorDirty();
            return;
        }

        if (event.key === "Backspace" && removeOrMergeBackward(block)) {
            event.preventDefault();
            markEditorDirty();
            return;
        }

        if (event.key === "Delete" && mergeForward(block)) {
            event.preventDefault();
            markEditorDirty();
            return;
        }
    }

    if (isPlainTextKey(event) && getSelectedBlockRange()) {
        event.preventDefault();
        replaceSelectionWithText(block, event.key);
        markEditorDirty();
    }
}

function handleEditorBeforeInput(event: InputEvent): void {
    const source = getFocusedBlockMarkdownSource();
    if (source && source.textContent === "" && event.inputType === "insertText" && event.data) {
        event.preventDefault();
        source.textContent = event.data;
        focusPlainTextElement(source, event.data.length);
        applyFocusedBlockMarkdownSourceInput(source);
        markEditorDirty();
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
    completeFencedParagraph(block);
    markEditorDirty();
}

function handleEditorCompositionStart(): void {
    isComposingText = true;
}

function handleEditorCompositionEnd(event: CompositionEvent): void {
    isComposingText = false;
    handleEditorInput(event);
}

function handleEditorInput(event: Event): void {
    const block = getActiveBlock(event.target);
    if (!block) {
        return;
    }

    commitTransientBlock(block);

    if (isCompositionEvent(event, isComposingText)) {
        markDocumentDirty();
        return;
    }

    const blockMarkdownSource = getFocusedBlockMarkdownSource();
    if (blockMarkdownSource) {
        applyFocusedBlockMarkdownSourceInput(blockMarkdownSource);
        markEditorDirty();
        return;
    }

    if (getFocusedMarkdownTokenSource()) {
        normalizeActiveMarkdownTokenSource(block);
        markEditorDirty();
        return;
    }

    if (rerenderPlainTextBlockMarkdownSource(block)) {
        markEditorDirty();
        return;
    }

    if (!completeFencedParagraph(block) && !applyMarkdownShortcut(block)) {
        renderBlockContent(block);
    }

    markEditorDirty();
}

function handleEditorPaste(event: ClipboardEvent): void {
    const text = event.clipboardData?.getData("text/plain");
    const block = getActiveBlock(event.target);

    if (!text || !block) {
        return;
    }

    event.preventDefault();
    commitTransientBlock(block);
    insertPastedText(block, text.replace(/\r\n?/g, "\n"));
    markEditorDirty();
}

function handleEditorCopy(event: ClipboardEvent): void {
    const markdown = readSelectedMarkdown();

    if (markdown === null || !event.clipboardData) {
        return;
    }

    event.preventDefault();
    writeMarkdownToClipboard(event.clipboardData, markdown);
}

function handleEditorCut(event: ClipboardEvent): void {
    const markdown = readSelectedMarkdown();

    if (markdown === null || !event.clipboardData) {
        return;
    }

    event.preventDefault();
    writeMarkdownToClipboard(event.clipboardData, markdown);

    if (deleteSelectedContent()) {
        markEditorDirty();
    }
}

function writeMarkdownToClipboard(clipboardData: DataTransfer, markdown: string): void {
    clipboardData.setData("text/plain", markdown);
    clipboardData.setData("text/markdown", markdown);
}

function syncActiveBlockIndicator(block: HTMLElement | null): void {
    const nextBlock = block?.isConnected ? block : null;

    if (indicatedActiveBlock === nextBlock) {
        return;
    }

    if (indicatedActiveBlock) {
        delete indicatedActiveBlock.dataset.activeBlock;
    }

    indicatedActiveBlock = nextBlock;

    if (indicatedActiveBlock) {
        indicatedActiveBlock.dataset.activeBlock = "true";
    }
}

function syncBlockMarkdownSourceReveal(block: HTMLElement | null): void {
    const nextBlocks = new Set<HTMLElement>();
    const activeBlock = block?.isConnected ? block : null;

    if (activeBlock) {
        addBlockMarkdownSourceRevealTarget(nextBlocks, activeBlock);
    }

    for (const revealedBlock of markdownSourceRevealBlocks) {
        if (!nextBlocks.has(revealedBlock)) {
            delete revealedBlock.dataset.markdownSourceActive;
        }
    }

    for (const revealedBlock of Array.from(nextBlocks)) {
        revealedBlock.dataset.markdownSourceActive = "true";
    }

    markdownSourceRevealBlocks = Array.from(nextBlocks);
}

function addBlockMarkdownSourceRevealTarget(targets: Set<HTMLElement>, block: HTMLElement | null): void {
    if (!block?.isConnected) {
        return;
    }

    const type = readBlockType(block.dataset.type);
    if (hasBlockMarkdownSource(type)) {
        targets.add(block);
    }
}

function completeFencedParagraph(block: HTMLElement): boolean {
    if (!completeCodeBlockFromFencedParagraph(block)) {
        return false;
    }

    syncBlockMarkdownSourceReveal(block);
    return true;
}

function renderBlockContent(block: HTMLElement): void {
    const focusOffset = rerenderInlineBlockContent(block, getCurrentBlockOffset(block));

    if (focusOffset === null) {
        return;
    }

    focusBlockAtOffset(block, focusOffset);
    suppressAdjacentFormatTokenActivation(block, focusOffset);
    activateMarkdownTokenAtCaret();
}
