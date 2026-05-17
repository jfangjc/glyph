import { Browser, Window } from "@wailsio/runtime";
import {
    findAdjacentInactiveMarkdownToken,
    findMarkdownTokenAtCaret,
    findMarkdownTextPosition,
    getMarkdownBoundaryOffset,
    getMarkdownLengthBeforeChild,
    getMarkdownText,
    type MarkdownTokenEdge,
} from "../formats/markdown/dom";
import { parseMarkdownDocument, parseMarkdownFragment, serializeMarkdownDocument } from "../formats/markdown/document";
import { hydrateMarkdownImagePreviews } from "../formats/markdown/images";
import { findFirstInlineToken, renderInlineMarkdown } from "../formats/markdown/inline";
import { parseMarkdownReferenceDefinition, type MarkdownReferenceMap } from "../formats/markdown/references";
import { markdownShortcuts } from "../formats/markdown/shortcuts";
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
import { blockLabels, headingTypes, readBlockType, type BlockType, type ParsedBlock } from "./block-model";

type SelectedBlockRange = {
    blocks: HTMLElement[];
    startBlock: HTMLElement;
    endBlock: HTMLElement;
    startOffset: number;
    endOffset: number;
};

type InlineFormat = "bold" | "italic";

let suppressSelectionChange = false;
let suppressedMarkdownTokenActivation: { block: HTMLElement; offset: number } | null = null;
let pendingHorizontalNavigationTarget: { token: HTMLElement; edge: MarkdownTokenEdge; requestId: number } | null = null;
let pendingHorizontalNavigationRequestId = 0;
let pendingVerticalLeadingTokenNavigationRequestId = 0;
let pendingVerticalLeadingTokenNavigationTarget: { requestId: number } | null = null;
let markdownReferences: MarkdownReferenceMap = {};
let indicatedActiveBlock: HTMLElement | null = null;

export function installEditorController(): void {
    const surface = getElement<HTMLElement>("document-surface");
    const editor = getElement<HTMLElement>("editor");
    const title = getElement<HTMLInputElement>("document-title");

    surface.addEventListener("mousedown", handleDocumentSurfaceMouseDown);
    editor.addEventListener("keydown", handleEditorKeydown);
    editor.addEventListener("input", handleEditorInput);
    editor.addEventListener("paste", handleEditorPaste);
    editor.addEventListener("change", handleEditorChange);
    editor.addEventListener("click", handleEditorClick);
    title.addEventListener("input", handleTitleInput);
    title.addEventListener("focus", () => syncActiveBlockIndicator(null));
    document.addEventListener("selectionchange", handleSelectionChange);
    window.addEventListener("keydown", handleGlobalKeydown);
    window.addEventListener(documentStateChangedEvent, syncDocumentWindowTitle);
    bindDocumentActions({ loadDocument, serializeDocumentMarkdown });
    startDocumentAutosave();

    syncFirstBlockPlaceholder();
    syncDocumentWindowTitle();
}

function handleGlobalKeydown(event: KeyboardEvent): void {
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

function fileNameFromPath(path: string): string {
    const normalized = path.replace(/\\/g, "/");
    return normalized.slice(normalized.lastIndexOf("/") + 1) || path || "Untitled";
}

function handleTitleInput(): void {
    documentState.usesTitle = true;
    markDocumentDirty();
}

function handleDocumentSurfaceMouseDown(event: MouseEvent): void {
    if (event.button !== 0 || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
    }

    const target = event.target;
    if (!(target instanceof Element) || shouldLetBrowserHandlePointerTarget(target)) {
        return;
    }

    const block = findPointerTargetBlock(target, event.clientX, event.clientY);
    if (!block) {
        return;
    }

    event.preventDefault();
    focusBlockAtOffset(block, getPointerCaretOffset(block, event.clientX, event.clientY));
}

function shouldLetBrowserHandlePointerTarget(target: Element): boolean {
    return Boolean(
        target.closest(
            "#document-title, .block-content, .todo-checkbox, button, input, textarea, select, [contenteditable='false']",
        ),
    );
}

function findPointerTargetBlock(target: Element, clientX: number, clientY: number): HTMLElement | null {
    const directBlock = findBlock(target);
    if (directBlock) {
        return directBlock;
    }

    const blocks = getEditorBlocks();
    if (blocks.length === 0) {
        return null;
    }

    const firstBlock = blocks[0];
    const firstRect = firstBlock.getBoundingClientRect();
    if (clientY < firstRect.top) {
        return firstBlock;
    }

    let previousBlock = firstBlock;
    for (const block of blocks) {
        const rect = block.getBoundingClientRect();

        if (clientY >= rect.top && clientY <= rect.bottom) {
            return block;
        }

        if (clientY < rect.top) {
            return previousBlock;
        }

        previousBlock = block;
    }

    return ensurePointerTrailingParagraph();
}

function ensurePointerTrailingParagraph(): HTMLElement {
    const blocks = getEditorBlocks();
    const lastBlock = blocks[blocks.length - 1];

    if (
        lastBlock &&
        readBlockType(lastBlock.dataset.type) === "paragraph" &&
        getBlockText(lastBlock) === ""
    ) {
        return lastBlock;
    }

    const nextBlock = createBlock("paragraph");
    nextBlock.dataset.transient = "true";

    if (lastBlock) {
        lastBlock.after(nextBlock);
    } else {
        getElement<HTMLElement>("editor").append(nextBlock);
    }

    syncFirstBlockPlaceholder();
    return nextBlock;
}

function getPointerCaretOffset(block: HTMLElement, clientX: number, clientY: number): number {
    const content = getBlockContent(block);
    const caretPosition = getCaretPositionFromPoint(clientX, clientY);

    if (caretPosition && (caretPosition.node === content || content.contains(caretPosition.node))) {
        return getCaretOffset(content, caretPosition.node, caretPosition.offset);
    }

    const rect = content.getBoundingClientRect();
    if (clientY < rect.top || clientX <= rect.left) {
        return 0;
    }

    return getBlockText(block).length;
}

function getCaretPositionFromPoint(clientX: number, clientY: number): { node: Node; offset: number } | null {
    const documentWithCaretPosition = document as Document & {
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const position = documentWithCaretPosition.caretPositionFromPoint?.(clientX, clientY);
    if (position) {
        return { node: position.offsetNode, offset: position.offset };
    }

    const range = documentWithCaretPosition.caretRangeFromPoint?.(clientX, clientY);
    if (range) {
        return { node: range.startContainer, offset: range.startOffset };
    }

    return null;
}

function handleEditorChange(event: Event): void {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.classList.contains("todo-checkbox")) {
        syncActiveBlockIndicator(findBlock(target));
        markDocumentDirty();
    }
}

function handleEditorClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) {
        return;
    }

    const token = findClickedMarkdownToken(target);
    if (token) {
        if (target.closest(".markdown-token-source")) {
            setActiveMarkdownToken(token);
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        const link = token.querySelector<HTMLAnchorElement>("a.markdown-link");
        const href = link?.dataset.href;
        if (href && (event.ctrlKey || event.metaKey)) {
            void Browser.OpenURL(href).catch((error) => console.error("Failed to open URL:", error));
            return;
        }

        activateMarkdownTokenSource(token);
        return;
    }

    const link = target.closest("a.markdown-link") as HTMLAnchorElement | null;
    const href = link?.dataset.href;
    if (!href) {
        clearActiveMarkdownToken();
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    clearActiveMarkdownToken();

    if (event.ctrlKey || event.metaKey) {
        void Browser.OpenURL(href).catch((error) => console.error("Failed to open URL:", error));
    }
}

function findClickedMarkdownToken(target: Element): HTMLElement | null {
    const directToken = target.closest<HTMLElement>(".markdown-token");
    const containingToken = directToken?.parentElement?.closest<HTMLElement>(".markdown-token");

    if (containingToken && isEditableMarkdownToken(containingToken)) {
        return containingToken;
    }

    return directToken && isEditableMarkdownToken(directToken) ? directToken : null;
}

function handleSelectionChange(): void {
    if (suppressSelectionChange) {
        return;
    }

    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    syncActiveBlockIndicator(findBlock(focusNode ?? null));

    const focusElement = focusNode instanceof Element ? focusNode : focusNode?.parentElement;
    const source = focusElement?.closest<HTMLElement>(".markdown-token-source");
    const sourceToken = source ? getMarkdownTokenForSource(source) : null;

    if (sourceToken) {
        setActiveMarkdownToken(sourceToken);
        return;
    }

    if (selection?.isCollapsed && revealPendingHorizontalNavigationTarget()) {
        return;
    }

    if (selection?.isCollapsed && revealPendingVerticalLeadingTokenNavigationTarget()) {
        return;
    }

    if (selection?.isCollapsed && shouldSuppressMarkdownTokenActivation(selection)) {
        return;
    }

    if (activateMarkdownTokenAtCaret()) {
        return;
    }

    clearActiveMarkdownToken();
}

function shouldSuppressMarkdownTokenActivation(selection: Selection): boolean {
    const suppressed = suppressedMarkdownTokenActivation;
    const focusNode = selection.focusNode;
    if (!suppressed || !focusNode || !suppressed.block.isConnected) {
        suppressedMarkdownTokenActivation = null;
        return false;
    }

    const block = findBlock(focusNode);
    if (!block) {
        suppressedMarkdownTokenActivation = null;
        return false;
    }

    const offset = getCaretOffset(getBlockContent(block), focusNode, selection.focusOffset);
    if (block === suppressed.block && offset === suppressed.offset) {
        return true;
    }

    suppressedMarkdownTokenActivation = null;
    return false;
}

function setActiveMarkdownToken(token: HTMLElement): void {
    const editor = getElement<HTMLElement>("editor");
    const activeTokens = Array.from(editor.querySelectorAll<HTMLElement>(".markdown-token[data-active]"));

    if (activeTokens.length === 1 && activeTokens[0] === token && token.dataset.active === "true") {
        return;
    }

    for (const activeToken of activeTokens) {
        if (activeToken !== token) {
            deactivateMarkdownToken(activeToken);
        }
    }

    if (token.dataset.active !== "true") {
        token.dataset.sourceBeforeActivation = getMarkdownText(token);
    }

    token.dataset.active = "true";
}

function activateMarkdownTokenSource(token: HTMLElement, edge: "start" | "end" = "end"): void {
    setActiveMarkdownToken(token);
    suppressSelectionChangeForFrame();
    focusMarkdownTokenSource(token, edge);
}

function activateMarkdownTokenAtCaret(): boolean {
    const selection = document.getSelection();
    const focusNode = selection?.focusNode;

    if (!selection?.isCollapsed || !focusNode) {
        return false;
    }

    if (shouldSuppressMarkdownTokenActivation(selection)) {
        return false;
    }

    const tokenPosition = findMarkdownTokenAtCaret(focusNode, selection.focusOffset, isEditableMarkdownToken);
    if (!tokenPosition) {
        return false;
    }

    activateMarkdownTokenSource(tokenPosition.token, tokenPosition.edge);
    return true;
}

function revealPendingHorizontalNavigationTarget(): boolean {
    const target = pendingHorizontalNavigationTarget;
    pendingHorizontalNavigationTarget = null;

    if (!target?.token.isConnected || target.token.dataset.active === "true") {
        return false;
    }

    activateMarkdownTokenSource(target.token, target.edge);
    return true;
}

function revealPendingVerticalLeadingTokenNavigationTarget(): boolean {
    const target = pendingVerticalLeadingTokenNavigationTarget;
    pendingVerticalLeadingTokenNavigationTarget = null;

    if (!target) {
        return false;
    }

    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    if (!selection?.isCollapsed || !focusNode) {
        return false;
    }

    const previousToken = findAdjacentInactiveMarkdownToken(focusNode, selection.focusOffset, "previous");
    if (previousToken && isEditableMarkdownToken(previousToken) && isLeadingTokenInBlock(previousToken)) {
        activateMarkdownTokenSource(previousToken, "start");
        return true;
    }

    const nextToken = findAdjacentInactiveMarkdownToken(focusNode, selection.focusOffset, "next");
    if (nextToken && isEditableMarkdownToken(nextToken) && isLeadingTokenInBlock(nextToken)) {
        activateMarkdownTokenSource(nextToken, "start");
        return true;
    }

    return false;
}

function isLeadingTokenInBlock(token: HTMLElement): boolean {
    const block = findBlock(token);
    if (!block) {
        return false;
    }

    return getMarkdownBoundaryOffset(getBlockContent(block), token, 0) === 0;
}

function suppressSelectionChangeForFrame(): void {
    suppressSelectionChange = true;
    window.requestAnimationFrame(() => {
        suppressSelectionChange = false;
    });
}

function focusMarkdownTokenSource(token: HTMLElement, edge: "start" | "end" = "end"): void {
    const source = getMarkdownTokenSource(token);
    const selection = document.getSelection();
    const range = document.createRange();

    if (!source || !selection) {
        return;
    }

    const position = getTextPosition(source, edge === "start" ? 0 : (source.textContent?.length ?? 0));

    range.setStart(position.node, position.offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
}

function clearActiveMarkdownToken(
    options: { focusBlock?: HTMLElement; focusOffset?: number; suppressTokenActivationAtFocus?: boolean } = {},
): void {
    const editor = getElement<HTMLElement>("editor");
    const activeTokens = Array.from(editor.querySelectorAll<HTMLElement>(".markdown-token[data-active]"));

    if (activeTokens.length === 0) {
        return;
    }

    const selection = document.getSelection();
    const selectionBlock = options.focusBlock ?? findBlock(selection?.focusNode ?? null);
    const selectionOffset =
        options.focusOffset ??
        (selectionBlock && selection?.focusNode
            ? getCaretOffset(getBlockContent(selectionBlock), selection.focusNode, selection.focusOffset)
            : null);
    const blocks = Array.from(
        new Set(activeTokens.map((token) => findBlock(token)).filter((block): block is HTMLElement => Boolean(block))),
    );
    const updates = blocks.map((block) => {
        const tokens = activeTokens.filter((token) => findBlock(token) === block);

        return {
            block,
            tokens,
            text: getBlockText(block),
            hasSourceEdits: tokens.some(hasActiveMarkdownTokenSourceEdits),
            hasFormatToken: tokens.some(isFormatMarkdownToken),
        };
    });

    for (const update of updates) {
        if (update.hasSourceEdits || update.hasFormatToken) {
            setBlockText(update.block, update.text);
            continue;
        }

        for (const token of update.tokens) {
            deactivateMarkdownToken(token);
        }
    }

    if (selectionBlock?.isConnected && selectionOffset !== null) {
        const focusOffset = Math.min(selectionOffset, getBlockText(selectionBlock).length);

        if (options.suppressTokenActivationAtFocus || updates.some((update) => update.hasFormatToken)) {
            suppressedMarkdownTokenActivation = { block: selectionBlock, offset: focusOffset };
        }

        suppressSelectionChangeForFrame();
        focusBlockAtOffset(selectionBlock, focusOffset);
    }
}

function hasActiveMarkdownTokenSourceEdits(token: HTMLElement): boolean {
    return (
        token.dataset.sourceBeforeActivation !== undefined &&
        getMarkdownText(token) !== token.dataset.sourceBeforeActivation
    );
}

function isEditableMarkdownToken(token: HTMLElement): boolean {
    return getMarkdownTokenSource(token) !== null;
}

function getMarkdownTokenSource(token: HTMLElement): HTMLElement | null {
    return (
        Array.from(token.children).find(
            (child): child is HTMLElement =>
                child instanceof HTMLElement && child.classList.contains("markdown-token-source"),
        ) ?? null
    );
}

function getMarkdownTokenForSource(source: HTMLElement): HTMLElement | null {
    const parent = source.parentElement;
    return parent instanceof HTMLElement && parent.classList.contains("markdown-token") ? parent : null;
}

function isFormatMarkdownToken(token: HTMLElement): boolean {
    return token.classList.contains("markdown-format-token");
}

function deactivateMarkdownToken(token: HTMLElement): void {
    delete token.dataset.active;
    delete token.dataset.sourceBeforeActivation;
}

function loadDocument(documentFile: DocumentFile): void {
    const parsedDocument = parseMarkdownDocument(documentFile);
    const title = getElement<HTMLInputElement>("document-title");

    documentState.activeFilePath = documentFile.path;
    documentState.usesTitle = parsedDocument.usesTitle;
    markdownReferences = parsedDocument.references ?? {};
    title.value = parsedDocument.title;
    replaceEditorBlocks(parsedDocument.blocks);
    documentState.lastSavedMarkdown = serializeDocumentMarkdown();
    documentState.hasUnsavedChanges = false;
    notifyDocumentStateChanged();
}

function serializeDocumentMarkdown(): string {
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
    const activeOffset =
        activeBlock && selection?.focusNode
            ? getCaretOffset(getBlockContent(activeBlock), selection.focusNode, selection.focusOffset)
            : null;

    for (const block of getEditorBlocks()) {
        if (isInlineMarkdownBlockType(readBlockType(block.dataset.type))) {
            setBlockText(block, getBlockText(block));
        }
    }

    if (activeBlock?.isConnected && activeOffset !== null) {
        focusBlockAtOffset(activeBlock, Math.min(activeOffset, getBlockText(activeBlock).length));
    }
}

function readEditorBlock(block: HTMLElement): ParsedBlock {
    const type = readBlockType(block.dataset.type);

    return {
        type,
        text: getBlockText(block),
        indent: readBlockIndent(block),
        checked: type === "todo" ? getTodoCheckbox(block).checked : undefined,
        codeInfo: block.dataset.codeInfo,
        listMarker: readBlockListMarker(block),
        listNumber: readBlockListNumber(block),
        quoteLevel: readBlockQuoteLevel(block),
    };
}

function getSerializableEditorBlocks(): HTMLElement[] {
    const blocks = getEditorBlocks();
    let endIndex = blocks.length;

    while (endIndex > 1 && isEmptyTransientParagraph(blocks[endIndex - 1])) {
        endIndex -= 1;
    }

    return blocks.slice(0, endIndex);
}

function isEmptyTransientParagraph(block: HTMLElement): boolean {
    return (
        block.dataset.transient === "true" &&
        readBlockType(block.dataset.type) === "paragraph" &&
        getBlockText(block) === ""
    );
}

function replaceEditorBlocks(blocks: ParsedBlock[]): void {
    const editor = getElement<HTMLElement>("editor");
    const nextBlocks = blocks.map((block) => createBlock(block.type, block.text, block));

    editor.replaceChildren(...nextBlocks);
    syncFirstBlockPlaceholder();
    focusBlockAtOffset(nextBlocks[0], 0);
}

function syncFirstBlockPlaceholder(): void {
    const [firstBlock, ...remainingBlocks] = getEditorBlocks();

    if (!firstBlock) {
        return;
    }

    for (const block of remainingBlocks) {
        delete getBlockContent(block).dataset.placeholder;
    }
}

function handleEditorKeydown(event: KeyboardEvent): void {
    const editor = getElement<HTMLElement>("editor");

    if (isSelectAllShortcut(event)) {
        event.preventDefault();
        selectEditorContents(editor);
        return;
    }

    const block = getActiveBlock(event.target);
    if (!block) {
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

        if (readBlockType(targetBlock.dataset.type) === "code" && !event.ctrlKey && !event.metaKey) {
            replaceSelectionWithText(targetBlock, "\n");
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

function trackHorizontalMarkdownNavigation(event: KeyboardEvent): void {
    if (
        (event.key !== "ArrowLeft" && event.key !== "ArrowRight") ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
    ) {
        pendingHorizontalNavigationTarget = null;
        return;
    }

    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    if (!selection?.isCollapsed || !focusNode) {
        pendingHorizontalNavigationTarget = null;
        return;
    }

    const direction = event.key === "ArrowLeft" ? "previous" : "next";
    const token = findAdjacentInactiveMarkdownToken(focusNode, selection.focusOffset, direction);
    if (!token || !isEditableMarkdownToken(token)) {
        pendingHorizontalNavigationTarget = null;
        return;
    }

    const requestId = pendingHorizontalNavigationRequestId + 1;
    pendingHorizontalNavigationRequestId = requestId;
    pendingHorizontalNavigationTarget = {
        token,
        edge: direction === "previous" ? "end" : "start",
        requestId,
    };

    window.requestAnimationFrame(() => {
        if (pendingHorizontalNavigationTarget?.requestId === requestId) {
            revealPendingHorizontalNavigationTarget();
        }
    });
}

function trackVerticalLeadingTokenNavigation(event: KeyboardEvent, block: HTMLElement): void {
    if (
        (event.key !== "ArrowUp" && event.key !== "ArrowDown") ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
    ) {
        pendingVerticalLeadingTokenNavigationTarget = null;
        return;
    }

    const selection = document.getSelection();
    if (!selection?.isCollapsed || getCurrentBlockOffset(block) !== 0) {
        pendingVerticalLeadingTokenNavigationTarget = null;
        return;
    }

    const requestId = pendingVerticalLeadingTokenNavigationRequestId + 1;
    pendingVerticalLeadingTokenNavigationRequestId = requestId;
    pendingVerticalLeadingTokenNavigationTarget = { requestId };

    window.requestAnimationFrame(() => {
        if (pendingVerticalLeadingTokenNavigationTarget?.requestId === requestId) {
            revealPendingVerticalLeadingTokenNavigationTarget();
        }
    });
}

function trackVerticalMarkdownImageNavigation(event: KeyboardEvent, block: HTMLElement): boolean {
    if (
        (event.key !== "ArrowUp" && event.key !== "ArrowDown") ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
    ) {
        return false;
    }

    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    if (!selection?.isCollapsed || !focusNode) {
        return false;
    }

    const direction = event.key === "ArrowUp" ? "previous" : "next";
    const targetToken = findVerticalMarkdownImageToken(block, direction);
    if (!targetToken) {
        return false;
    }

    event.preventDefault();
    pendingHorizontalNavigationTarget = null;
    pendingVerticalLeadingTokenNavigationTarget = null;
    activateMarkdownTokenSource(targetToken, direction === "previous" ? "end" : "start");
    return true;
}

function handleEditorInput(event: Event): void {
    const block = getActiveBlock(event.target);
    if (!block) {
        return;
    }

    commitTransientBlock(block);

    if (isEditingMarkdownTokenSource()) {
        normalizeActiveMarkdownTokenSource(block);
        markEditorDirty();
        return;
    }

    if (!applyMarkdownShortcut(block)) {
        renderBlockContent(block);
    }

    markEditorDirty();
}

function isEditingMarkdownTokenSource(): boolean {
    const focusNode = document.getSelection()?.focusNode;
    const focusElement = focusNode instanceof Element ? focusNode : focusNode?.parentElement;

    return Boolean(focusElement?.closest(".markdown-token-source"));
}

function moveCaretOutOfActiveMarkdownTokenSource(event: KeyboardEvent, block: HTMLElement): boolean {
    if (
        (event.key !== "ArrowLeft" && event.key !== "ArrowRight") ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
    ) {
        return false;
    }

    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    const focusElement = focusNode instanceof Element ? focusNode : focusNode?.parentElement;
    const source = focusElement?.closest<HTMLElement>(".markdown-token-source");
    const token = source ? getMarkdownTokenForSource(source) : null;

    if (!selection?.isCollapsed || !focusNode || !source || token?.dataset.active !== "true") {
        return false;
    }

    const sourceOffset = getCaretOffset(source, focusNode, selection.focusOffset);
    const sourceLength = getMarkdownText(source).length;
    const isLeavingStart = event.key === "ArrowLeft" && sourceOffset === 0;
    const isLeavingEnd = event.key === "ArrowRight" && sourceOffset === sourceLength;

    if (!isLeavingStart && !isLeavingEnd) {
        return false;
    }

    const blockOffset = getCaretOffset(getBlockContent(block), focusNode, selection.focusOffset);
    pendingHorizontalNavigationTarget = null;
    clearActiveMarkdownToken({ focusBlock: block, focusOffset: blockOffset, suppressTokenActivationAtFocus: true });
    return true;
}

function normalizeActiveMarkdownTokenSource(block: HTMLElement): void {
    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    const focusElement = focusNode instanceof Element ? focusNode : focusNode?.parentElement;
    const source = focusElement?.closest<HTMLElement>(".markdown-token-source");

    if (!selection?.isCollapsed || !focusNode || !source) {
        return;
    }

    if (source.closest(".markdown-format-token")) {
        return;
    }

    const text = getMarkdownText(source);
    const tokenMatch = findFirstInlineToken(text);
    if (!tokenMatch || (tokenMatch.start === 0 && tokenMatch.token.raw.length === text.length)) {
        return;
    }

    const content = getBlockContent(block);
    const offset = getCaretOffset(content, focusNode, selection.focusOffset);
    const markdown = getBlockText(block);

    setBlockText(block, markdown);
    focusBlockAtOffset(block, Math.min(offset, getBlockText(block).length));
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

function commitTransientBlock(block: HTMLElement): void {
    delete block.dataset.transient;
}

function splitBlock(block: HTMLElement): void {
    const content = getBlockContent(block);
    const selection = document.getSelection();
    const text = getBlockText(block);
    const offset = selection?.focusNode
        ? getCaretOffset(content, selection.focusNode, selection.focusOffset)
        : text.length;
    const currentType = readBlockType(block.dataset.type);

    if (text === "" && shouldResetEmptyBlock(currentType)) {
        clearBlockProperties(block);
        focusBlockAtOffset(block, 0);
        return;
    }

    const before = text.slice(0, offset);
    const after = text.slice(offset);
    const nextType = readSplitContinuationType(currentType);
    const nextBlock = createBlock(nextType, after, {
        indent: isIndentableListBlockType(nextType) ? readBlockIndent(block) : 0,
        listMarker: readBlockListMarker(block),
        listNumber: nextType === "ordered-list" ? readNextListNumber(block) : undefined,
        quoteLevel: nextType === "quote" ? readBlockQuoteLevel(block) : undefined,
    });

    setBlockText(block, before);
    block.after(nextBlock);
    focusBlockAtOffset(nextBlock, 0);
}

function startCodeBlockFromFence(block: HTMLElement): boolean {
    if (readBlockType(block.dataset.type) !== "paragraph" || !isCaretAtBlockEdge(block, "end")) {
        return false;
    }

    const match = getBlockText(block).match(/^(`{3,}|~{3,})(.*)$/);
    if (!match) {
        return false;
    }

    setBlockType(block, "code");
    setCodeInfo(block, match[2].trim());
    setBlockText(block, "");
    ensureEditableBlockAfter(block);
    focusBlockAtOffset(block, 0);
    return true;
}

function applyMarkdownShortcut(block: HTMLElement): boolean {
    const text = getBlockText(block);
    const referenceDefinition = parseMarkdownReferenceDefinition(text);
    if (referenceDefinition) {
        setBlockType(block, "reference");
        setBlockText(block, text);
        ensureEditableBlockAfter(block);
        focusBlock(block);
        return true;
    }

    const shortcut = markdownShortcuts.find((candidate) =>
        candidate.exact ? text === candidate.marker : text.startsWith(candidate.marker),
    );

    if (!shortcut) {
        return false;
    }

    setBlockType(block, shortcut.type);
    setBlockIndent(block, shortcut.indent ?? 0);
    setBlockListMarker(block, shortcut.listMarker);
    setBlockListNumber(block, shortcut.listNumber);
    setBlockText(block, text.slice(shortcut.marker.length));
    ensureEditableBlockAfter(block);

    if (shortcut.type === "rule") {
        const nextBlock = getSiblingBlock(block, "next");
        focusBlockAtOffset(nextBlock ?? block, 0);
        return true;
    }

    focusBlock(block);
    return true;
}

function createBlock(type: BlockType = "paragraph", text = "", options: Partial<ParsedBlock> = {}): HTMLElement {
    const blockTemplate = getElement<HTMLTemplateElement>("block-template");
    const fragment = blockTemplate.content.cloneNode(true) as DocumentFragment;
    const block = fragment.querySelector<HTMLElement>("[data-block]");

    if (!block) {
        throw new Error("Block template is missing [data-block]");
    }

    setBlockType(block, type);
    setBlockIndent(block, options.indent ?? 0);
    setBlockListMarker(block, options.listMarker);
    setBlockListNumber(block, options.listNumber);
    setBlockQuoteLevel(block, options.quoteLevel);
    setTodoChecked(block, options.checked ?? false);
    setCodeInfo(block, options.codeInfo ?? "");
    setBlockText(block, text);
    return block;
}

function setBlockType(block: HTMLElement, type: BlockType): void {
    block.dataset.type = type;
    getBlockContent(block).setAttribute("aria-label", `${blockLabels[type]} block`);

    if (!isIndentableListBlockType(type)) {
        setBlockIndent(block, 0);
    }

    if (!usesBulletListMarker(type)) {
        delete block.dataset.listMarker;
    }

    if (type !== "ordered-list") {
        delete block.dataset.listNumber;
    }

    if (type !== "code") {
        delete block.dataset.codeInfo;
    }

    if (type !== "quote") {
        delete block.dataset.quoteLevel;
    }
}

function setBlockText(block: HTMLElement, text: string): void {
    const content = getBlockContent(block);
    const type = readBlockType(block.dataset.type);

    if (text !== "") {
        delete block.dataset.transient;
    }

    if (isPlainTextBlockType(type)) {
        content.textContent = text;
        delete content.dataset.renderedMarkdown;
        return;
    }

    if (isAtomicBlockType(type)) {
        content.textContent = "";
        delete content.dataset.renderedMarkdown;
        return;
    }

    const html = renderInlineMarkdown(text, markdownReferences);

    content.innerHTML = html;
    content.dataset.renderedMarkdown = html;
    hydrateMarkdownImagePreviews(content, documentState.activeFilePath);
}

function setBlockIndent(block: HTMLElement, indent: number): void {
    if (isIndentableListBlockType(readBlockType(block.dataset.type)) && indent > 0) {
        block.dataset.indent = String(Math.min(indent, 3));
        return;
    }

    delete block.dataset.indent;
}

function setBlockListMarker(block: HTMLElement, marker: string | undefined): void {
    const type = readBlockType(block.dataset.type);

    if (usesBulletListMarker(type)) {
        block.dataset.listMarker = marker && ["-", "*", "+"].includes(marker) ? marker : "-";
        return;
    }

    delete block.dataset.listMarker;
}

function setBlockListNumber(block: HTMLElement, value: string | undefined): void {
    if (readBlockType(block.dataset.type) === "ordered-list") {
        block.dataset.listNumber = value && /^\d{1,9}$/.test(value) ? value : "1";
        return;
    }

    delete block.dataset.listNumber;
}

function setBlockQuoteLevel(block: HTMLElement, level: number | undefined): void {
    if (readBlockType(block.dataset.type) === "quote" && level && level > 1) {
        block.dataset.quoteLevel = String(Math.min(level, 6));
        return;
    }

    delete block.dataset.quoteLevel;
}

function setTodoChecked(block: HTMLElement, checked: boolean): void {
    getTodoCheckbox(block).checked = checked;
}

function setCodeInfo(block: HTMLElement, codeInfo: string): void {
    if (readBlockType(block.dataset.type) === "code" && codeInfo) {
        block.dataset.codeInfo = codeInfo;
        return;
    }

    delete block.dataset.codeInfo;
}

function getBlockText(block: HTMLElement): string {
    const content = getBlockContent(block);
    const type = readBlockType(block.dataset.type);

    if (isPlainTextBlockType(type)) {
        return content.textContent ?? "";
    }

    if (isAtomicBlockType(type)) {
        return "";
    }

    return getMarkdownText(content);
}

function readBlockIndent(block: HTMLElement): number {
    const indent = Number(block.dataset.indent ?? 0);
    return Number.isFinite(indent) ? indent : 0;
}

function readBlockListMarker(block: HTMLElement): string | undefined {
    const marker = block.dataset.listMarker;
    return marker && ["-", "*", "+"].includes(marker) ? marker : undefined;
}

function readBlockListNumber(block: HTMLElement): string | undefined {
    const number = block.dataset.listNumber;
    return number && /^\d{1,9}$/.test(number) ? number : undefined;
}

function readNextListNumber(block: HTMLElement): string {
    const number = Number(readBlockListNumber(block) ?? "1");
    return Number.isFinite(number) ? String(number + 1) : "1";
}

function readBlockQuoteLevel(block: HTMLElement): number | undefined {
    const level = Number(block.dataset.quoteLevel ?? 1);
    return Number.isFinite(level) && level > 1 ? level : undefined;
}

function readSplitContinuationType(type: BlockType): BlockType {
    return headingTypes.has(type) || isStandaloneBlockType(type) ? "paragraph" : type;
}

function isInlineMarkdownBlockType(type: BlockType): boolean {
    return !isStandaloneBlockType(type);
}

function isStandaloneBlockType(type: BlockType): boolean {
    return isPlainTextBlockType(type) || isAtomicBlockType(type);
}

function isPlainTextBlockType(type: BlockType): boolean {
    return type === "code" || type === "reference";
}

function isAtomicBlockType(type: BlockType): boolean {
    return type === "rule";
}

function isIndentableListBlockType(type: BlockType): boolean {
    return type === "list" || type === "ordered-list" || type === "todo";
}

function usesBulletListMarker(type: BlockType): boolean {
    return type === "list" || type === "todo";
}

function getBlockContent(block: HTMLElement): HTMLElement {
    const content = block.querySelector<HTMLElement>(".block-content");
    if (!content) {
        throw new Error("Block is missing .block-content");
    }
    return content;
}

function getTodoCheckbox(block: HTMLElement): HTMLInputElement {
    const checkbox = block.querySelector<HTMLInputElement>(".todo-checkbox");
    if (!checkbox) {
        throw new Error("Block is missing .todo-checkbox");
    }

    return checkbox;
}

function findBlock(target: EventTarget | Node | null): HTMLElement | null {
    if (!(target instanceof Node)) {
        return null;
    }

    const element = target instanceof Element ? target : target.parentElement;
    return element?.closest("[data-block]") as HTMLElement | null;
}

function focusBlock(block: HTMLElement): void {
    focusBlockAtOffset(block, getBlockText(block).length);
}

function focusBlockAtOffset(block: HTMLElement, offset: number): void {
    const editor = getElement<HTMLElement>("editor");
    const content = getBlockContent(block);
    const selection = document.getSelection();
    const range = document.createRange();
    const position = getTextPosition(content, offset);

    editor.focus();

    range.setStart(position.node, position.offset);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    syncActiveBlockIndicator(block);
    scrollBlockIntoComfortableView(block);
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

function scrollBlockIntoComfortableView(block: HTMLElement): void {
    window.requestAnimationFrame(() => {
        if (!block.isConnected) {
            return;
        }

        const scroller = document.querySelector<HTMLElement>(".editor-shell");
        if (!scroller) {
            return;
        }

        const blockRect = block.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        const topInset = Math.min(96, scrollerRect.height * 0.2);
        const bottomInset = Math.min(160, scrollerRect.height * 0.28);
        const minimumTop = scrollerRect.top + topInset;
        const maximumBottom = scrollerRect.bottom - bottomInset;

        if (blockRect.bottom > maximumBottom) {
            scroller.scrollTop += blockRect.bottom - maximumBottom;
            return;
        }

        if (blockRect.top < minimumTop) {
            scroller.scrollTop -= minimumTop - blockRect.top;
        }
    });
}

function getCaretOffset(root: HTMLElement, anchorNode: Node, anchorOffset: number): number {
    if (anchorNode === root) {
        return getMarkdownLengthBeforeChild(root, anchorOffset);
    }

    if (!root.contains(anchorNode)) {
        return getMarkdownText(root).length;
    }

    return getMarkdownBoundaryOffset(root, anchorNode, anchorOffset);
}

function getCurrentBlockOffset(block: HTMLElement): number {
    const content = getBlockContent(block);
    const selection = document.getSelection();

    if (selection?.focusNode && (selection.focusNode === content || content.contains(selection.focusNode))) {
        return getCaretOffset(content, selection.focusNode, selection.focusOffset);
    }

    return getBlockText(block).length;
}

function getTextPosition(root: HTMLElement, offset: number): { node: Node; offset: number } {
    const position = findMarkdownTextPosition(root, Math.max(0, offset));

    if (position) {
        return position;
    }

    return { node: root, offset: root.childNodes.length };
}

function getActiveBlock(target: EventTarget | Node | null): HTMLElement | null {
    return findBlock(target) ?? findBlock(document.getSelection()?.focusNode ?? null);
}

function getEditorBlocks(): HTMLElement[] {
    const editor = getElement<HTMLElement>("editor");
    return Array.from(editor.querySelectorAll<HTMLElement>("[data-block]"));
}

function getSelectedBlockRange(): SelectedBlockRange | null {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return null;
    }

    const range = selection.getRangeAt(0);
    const startBlock = findBlockFromBoundary(range.startContainer, range.startOffset, "start");
    const endBlock = findBlockFromBoundary(range.endContainer, range.endOffset, "end");
    const allBlocks = getEditorBlocks();
    const startIndex = startBlock ? allBlocks.indexOf(startBlock) : -1;
    const endIndex = endBlock ? allBlocks.indexOf(endBlock) : -1;

    if (!startBlock || !endBlock || startIndex < 0 || endIndex < 0) {
        return null;
    }

    return {
        blocks: allBlocks.slice(startIndex, endIndex + 1),
        startBlock,
        endBlock,
        startOffset: getBoundaryOffset(startBlock, range.startContainer, range.startOffset, "start"),
        endOffset: getBoundaryOffset(endBlock, range.endContainer, range.endOffset, "end"),
    };
}

function findBlockFromBoundary(container: Node, offset: number, edge: "start" | "end"): HTMLElement | null {
    const directBlock = findBlock(container);
    if (directBlock) {
        return directBlock;
    }

    if (!(container instanceof HTMLElement) || container.id !== "editor") {
        return null;
    }

    const blocks = getEditorBlocks();
    if (edge === "start") {
        return blocks[offset] ?? blocks[blocks.length - 1] ?? null;
    }

    return blocks[offset - 1] ?? blocks[0] ?? null;
}

function getBoundaryOffset(block: HTMLElement, container: Node, offset: number, edge: "start" | "end"): number {
    const content = getBlockContent(block);
    if (container === content || content.contains(container)) {
        return getCaretOffset(content, container, offset);
    }

    return edge === "start" ? 0 : getBlockText(block).length;
}

function deleteSelectedContent(): HTMLElement | null {
    const selectedRange = getSelectedBlockRange();
    if (!selectedRange) {
        return null;
    }

    const { blocks, startBlock, endBlock, startOffset, endOffset } = selectedRange;
    const startText = getBlockText(startBlock);
    const endText = getBlockText(endBlock);

    if (startBlock === endBlock) {
        setBlockText(startBlock, startText.slice(0, startOffset) + startText.slice(endOffset));
        focusBlockAtOffset(startBlock, startOffset);
        return startBlock;
    }

    setBlockText(startBlock, startText.slice(0, startOffset) + endText.slice(endOffset));

    for (const block of blocks.slice(1)) {
        block.remove();
    }

    if (getBlockText(startBlock) === "") {
        setBlockType(startBlock, "paragraph");
    }

    focusBlockAtOffset(startBlock, startOffset);
    return startBlock;
}

function replaceSelectionWithText(block: HTMLElement, text: string): void {
    const selectedBlock = deleteSelectedContent() ?? block;
    insertTextAtCaret(selectedBlock, text);
}

function applyInlineFormatShortcut(block: HTMLElement, format: InlineFormat): boolean {
    const marker = format === "bold" ? "**" : "*";
    const selectedRange = getSelectedBlockRange();

    if (!selectedRange) {
        return insertInlineFormatPair(block, marker);
    }

    return toggleInlineFormatForSelection(selectedRange, marker);
}

function insertInlineFormatPair(block: HTMLElement, marker: string): boolean {
    if (!isInlineMarkdownBlockType(readBlockType(block.dataset.type))) {
        return false;
    }

    const content = getBlockContent(block);
    const selection = document.getSelection();
    const text = getBlockText(block);
    const offset = selection?.focusNode
        ? getCaretOffset(content, selection.focusNode, selection.focusOffset)
        : text.length;

    setBlockText(block, text.slice(0, offset) + marker + marker + text.slice(offset));
    focusBlockAtOffset(block, offset + marker.length);
    return true;
}

function toggleInlineFormatForSelection(selectedRange: SelectedBlockRange, marker: string): boolean {
    let changed = false;
    let focusTarget: { block: HTMLElement; offset: number } | null = null;

    for (const block of selectedRange.blocks) {
        if (!isInlineMarkdownBlockType(readBlockType(block.dataset.type))) {
            continue;
        }

        const text = getBlockText(block);
        const start = block === selectedRange.startBlock ? selectedRange.startOffset : 0;
        const end = block === selectedRange.endBlock ? selectedRange.endOffset : text.length;
        const update = toggleInlineFormatInText(text, start, end, marker);

        if (!update) {
            continue;
        }

        setBlockText(block, update.text);
        changed = true;
        focusTarget = { block, offset: update.focusOffset };
    }

    if (focusTarget) {
        focusBlockAtOffset(focusTarget.block, focusTarget.offset);
    }

    return changed;
}

function toggleInlineFormatInText(
    text: string,
    start: number,
    end: number,
    marker: string,
): { text: string; focusOffset: number } | null {
    if (start === end) {
        return null;
    }

    const selectedText = text.slice(start, end);
    if (selectedText.startsWith(marker) && selectedText.endsWith(marker) && selectedText.length >= marker.length * 2) {
        return {
            text:
                text.slice(0, start) +
                selectedText.slice(marker.length, selectedText.length - marker.length) +
                text.slice(end),
            focusOffset: end - marker.length * 2,
        };
    }

    if (text.slice(start - marker.length, start) === marker && text.slice(end, end + marker.length) === marker) {
        return {
            text: text.slice(0, start - marker.length) + selectedText + text.slice(end + marker.length),
            focusOffset: end - marker.length,
        };
    }

    return {
        text: text.slice(0, start) + marker + selectedText + marker + text.slice(end),
        focusOffset: end + marker.length * 2,
    };
}

function insertTextAtCaret(block: HTMLElement, text: string): void {
    const content = getBlockContent(block);
    const selection = document.getSelection();
    const selectedText = getBlockText(block);
    const offset = selection?.focusNode
        ? getCaretOffset(content, selection.focusNode, selection.focusOffset)
        : selectedText.length;

    setBlockText(block, selectedText.slice(0, offset) + text + selectedText.slice(offset));
    focusBlockAtOffset(block, offset + text.length);
}

function insertPastedText(block: HTMLElement, text: string): void {
    const selectedBlock = deleteSelectedContent() ?? block;

    if (readBlockType(selectedBlock.dataset.type) === "code") {
        insertTextAtCaret(selectedBlock, text);
        return;
    }

    const content = getBlockContent(selectedBlock);
    const selection = document.getSelection();
    const currentText = getBlockText(selectedBlock);
    const offset = selection?.focusNode
        ? getCaretOffset(content, selection.focusNode, selection.focusOffset)
        : currentText.length;
    const before = currentText.slice(0, offset);
    const after = currentText.slice(offset);
    const isWholeBlockPaste = before === "" && after === "";

    if (isWholeBlockPaste && shouldParsePastedMarkdown(text)) {
        replaceBlockWithPastedMarkdown(selectedBlock, text);
        return;
    }

    const lines = text.split("\n");

    if (before === "" && lines.length > 1) {
        replaceBlockWithPastedMarkdown(selectedBlock, text, after);
        return;
    }

    if (lines.length === 1) {
        if (before === "" && replaceSingleLineBlockStartWithPastedMarkdown(selectedBlock, text, after)) {
            return;
        }

        setBlockText(selectedBlock, before + text + after);
        focusBlockAtOffset(selectedBlock, before.length + text.length);
        return;
    }

    setBlockText(selectedBlock, before + lines[0]);
    insertParsedPastedBlocksAfter(selectedBlock, lines.slice(1).join("\n"), after);
}

function shouldParsePastedMarkdown(text: string): boolean {
    return (
        text.includes("\n") ||
        parseMarkdownFragment(text).blocks.some((block) => block.type !== "paragraph" || block.text !== text)
    );
}

function replaceSingleLineBlockStartWithPastedMarkdown(block: HTMLElement, text: string, after: string): boolean {
    const combinedText = text + after;
    const parsedBlocks = parseMarkdownFragment(combinedText).blocks;
    const parsedBlock = parsedBlocks.length === 1 ? parsedBlocks[0] : null;

    if (!parsedBlock || (parsedBlock.type === "paragraph" && parsedBlock.text === combinedText)) {
        return false;
    }

    const nextBlock = createBlock(parsedBlock.type, parsedBlock.text, parsedBlock);

    block.replaceWith(nextBlock);
    syncFirstBlockPlaceholder();
    focusBlockAtOffset(nextBlock, Math.max(0, getBlockText(nextBlock).length - after.length));
    return true;
}

function replaceBlockWithPastedMarkdown(block: HTMLElement, text: string, after = ""): void {
    const parsedBlocks = parseMarkdownFragment(text).blocks;
    const focusTarget = appendTextAfterParsedPaste(parsedBlocks, after);
    const nextBlocks = parsedBlocks.map((parsedBlock) => createBlock(parsedBlock.type, parsedBlock.text, parsedBlock));
    const focusBlock = nextBlocks[focusTarget.blockIndex];

    block.replaceWith(...nextBlocks);
    syncFirstBlockPlaceholder();
    focusBlockAtOffset(focusBlock, focusTarget.offset);
}

function insertParsedPastedBlocksAfter(block: HTMLElement, text: string, after: string): void {
    const parsedBlocks = parseMarkdownFragment(text).blocks;
    const focusTarget = appendTextAfterParsedPaste(parsedBlocks, after);
    const nextBlocks = parsedBlocks.map((parsedBlock) => createBlock(parsedBlock.type, parsedBlock.text, parsedBlock));
    const focusBlock = nextBlocks[focusTarget.blockIndex];

    block.after(...nextBlocks);
    syncFirstBlockPlaceholder();
    focusBlockAtOffset(focusBlock, focusTarget.offset);
}

function appendTextAfterParsedPaste(blocks: ParsedBlock[], after: string): { blockIndex: number; offset: number } {
    const lastBlockIndex = Math.max(0, blocks.length - 1);
    const lastBlock = blocks[lastBlockIndex];
    const focusOffset = lastBlock.text.length;

    if (!after) {
        return { blockIndex: lastBlockIndex, offset: focusOffset };
    }

    if (canAppendTextToParsedPasteBlock(lastBlock)) {
        lastBlock.text += after;
        return { blockIndex: lastBlockIndex, offset: focusOffset };
    }

    blocks.push({ type: "paragraph", text: after });
    return { blockIndex: blocks.length - 1, offset: 0 };
}

function canAppendTextToParsedPasteBlock(block: ParsedBlock): boolean {
    return isInlineMarkdownBlockType(block.type);
}

function indentListBlocks(block: HTMLElement, delta: number): boolean {
    const selectedRange = getSelectedBlockRange();
    const blocks = selectedRange?.blocks ?? [block];
    const listBlocks = blocks.filter((candidate) => isIndentableListBlockType(readBlockType(candidate.dataset.type)));

    if (listBlocks.length === 0) {
        return false;
    }

    for (const listBlock of listBlocks) {
        setBlockIndent(listBlock, readBlockIndent(listBlock) + delta);
    }

    focusBlockAtOffset(block, getCurrentBlockOffset(block));
    return true;
}

function removeOrMergeBackward(block: HTMLElement): boolean {
    const type = readBlockType(block.dataset.type);

    if (!isCaretAtBlockEdge(block, "start")) {
        return false;
    }

    if (type !== "paragraph") {
        clearBlockProperties(block);
        focusBlockAtOffset(block, 0);
        return true;
    }

    if (getBlockText(block) === "") {
        const previous = getSiblingBlock(block, "previous");
        if (previous) {
            block.remove();
            focusBlock(previous);
            return true;
        }

        return true;
    }

    const previous = getSiblingBlock(block, "previous");
    if (!previous) {
        return true;
    }

    const offset = getBlockText(previous).length;
    setBlockText(previous, getBlockText(previous) + getBlockText(block));
    block.remove();
    focusBlockAtOffset(previous, offset);
    return true;
}

function clearBlockProperties(block: HTMLElement): void {
    setBlockType(block, "paragraph");
    setTodoChecked(block, false);
}

function ensureEditableBlockAfter(block: HTMLElement): void {
    if (getSiblingBlock(block, "next")) {
        return;
    }

    block.after(createBlock("paragraph"));
}

function mergeForward(block: HTMLElement): boolean {
    if (!isCaretAtBlockEdge(block, "end")) {
        return false;
    }

    const next = getSiblingBlock(block, "next");
    if (!next) {
        return true;
    }

    const offset = getBlockText(block).length;
    setBlockText(block, getBlockText(block) + getBlockText(next));
    next.remove();
    focusBlockAtOffset(block, offset);
    return true;
}

function getSiblingBlock(block: HTMLElement, direction: "previous" | "next"): HTMLElement | null {
    const sibling = direction === "previous" ? block.previousElementSibling : block.nextElementSibling;
    return sibling instanceof HTMLElement && sibling.matches("[data-block]") ? sibling : null;
}

function getOnlyInactiveImageToken(block: HTMLElement): HTMLElement | null {
    const content = getBlockContent(block);
    const tokens = Array.from(content.children).filter(
        (child): child is HTMLElement =>
            child instanceof HTMLElement && child.classList.contains("markdown-image-token"),
    );
    const token = tokens.length === 1 ? tokens[0] : null;

    if (!token || token.dataset.active === "true") {
        return null;
    }

    return getMarkdownText(content).trim() === getMarkdownText(token).trim() ? token : null;
}

function findVerticalMarkdownImageToken(block: HTMLElement, direction: "previous" | "next"): HTMLElement | null {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.focusNode) {
        return null;
    }

    const caretRect = getCollapsedSelectionRect(selection);
    if (!caretRect) {
        const sibling = getSiblingBlock(block, direction);
        return sibling && isCaretAtBlockEdge(block, direction === "previous" ? "start" : "end")
            ? getOnlyInactiveImageToken(sibling)
            : null;
    }

    const sibling = getSiblingBlock(block, direction);
    const searchBlocks = sibling ? [block, sibling] : [block];
    const candidates = searchBlocks.flatMap((candidateBlock) =>
        Array.from(getBlockContent(candidateBlock).querySelectorAll<HTMLElement>(".markdown-image-token")),
    );
    const lineHeight = readLineHeight(getBlockContent(block));
    const maximumDistance = Math.max(lineHeight * 3, 72);
    let best: { token: HTMLElement; distance: number; horizontalDistance: number } | null = null;

    for (const token of candidates) {
        if (token.dataset.active === "true") {
            continue;
        }

        const tokenRect = token.getBoundingClientRect();
        const distance = direction === "previous" ? caretRect.top - tokenRect.bottom : tokenRect.top - caretRect.bottom;

        if (distance < -1 || distance > maximumDistance) {
            continue;
        }

        const caretX = caretRect.left + caretRect.width / 2;
        const tokenX = tokenRect.left + tokenRect.width / 2;
        const horizontalDistance = Math.abs(caretX - tokenX);

        if (
            !best ||
            distance < best.distance ||
            (distance === best.distance && horizontalDistance < best.horizontalDistance)
        ) {
            best = { token, distance, horizontalDistance };
        }
    }

    return best?.token ?? null;
}

function readLineHeight(element: HTMLElement): number {
    const computedLineHeight = Number.parseFloat(window.getComputedStyle(element).lineHeight);
    return Number.isFinite(computedLineHeight) ? computedLineHeight : 24;
}

function getCollapsedSelectionRect(selection: Selection): DOMRect | null {
    if (selection.rangeCount === 0) {
        return null;
    }

    const range = selection.getRangeAt(0).cloneRange();
    const rect = Array.from(range.getClientRects()).find((candidate) => candidate.width > 0 || candidate.height > 0);

    if (rect) {
        return rect;
    }

    const boundingRect = range.getBoundingClientRect();
    return boundingRect.width > 0 || boundingRect.height > 0 ? boundingRect : null;
}

function isCaretAtBlockEdge(block: HTMLElement, edge: "start" | "end"): boolean {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed || !selection.focusNode) {
        return false;
    }

    const content = getBlockContent(block);
    if (selection.focusNode !== content && !content.contains(selection.focusNode)) {
        return false;
    }

    const offset = getCaretOffset(content, selection.focusNode, selection.focusOffset);
    return edge === "start" ? offset === 0 : offset === getBlockText(block).length;
}

function selectEditorContents(editor: HTMLElement): void {
    const blocks = getEditorBlocks();
    const firstBlock = blocks[0];
    const lastBlock = blocks[blocks.length - 1];

    if (!firstBlock || !lastBlock) {
        return;
    }

    const firstContent = getBlockContent(firstBlock);
    const lastContent = getBlockContent(lastBlock);
    const selection = document.getSelection();
    const range = document.createRange();

    editor.focus();
    range.setStart(firstContent, 0);
    range.setEnd(lastContent, lastContent.childNodes.length);
    selection?.removeAllRanges();
    selection?.addRange(range);
}

function renderBlockContent(block: HTMLElement): void {
    const type = readBlockType(block.dataset.type);

    if (!isInlineMarkdownBlockType(type)) {
        return;
    }

    const content = getBlockContent(block);
    const selection = document.getSelection();
    const offset =
        selection?.focusNode && (selection.focusNode === content || content.contains(selection.focusNode))
            ? getCaretOffset(content, selection.focusNode, selection.focusOffset)
            : getBlockText(block).length;
    const text = getBlockText(block);
    const html = renderInlineMarkdown(text, markdownReferences);

    if (content.dataset.renderedMarkdown === html) {
        return;
    }

    content.innerHTML = html;
    content.dataset.renderedMarkdown = html;
    hydrateMarkdownImagePreviews(content, documentState.activeFilePath);
    const focusOffset = Math.min(offset, getBlockText(block).length);

    focusBlockAtOffset(block, focusOffset);
    suppressAdjacentFormatTokenActivation(block, focusOffset);
    activateMarkdownTokenAtCaret();
}

function suppressAdjacentFormatTokenActivation(block: HTMLElement, offset: number): void {
    const position = getTextPosition(getBlockContent(block), offset);
    const tokenPosition = findMarkdownTokenAtCaret(position.node, position.offset, isFormatMarkdownToken);

    if (tokenPosition) {
        suppressedMarkdownTokenActivation = { block, offset };
    }
}

function shouldResetEmptyBlock(type: BlockType): boolean {
    return isIndentableListBlockType(type) || type === "quote" || type === "reference";
}

function isOpenFileShortcut(event: KeyboardEvent): boolean {
    return event.key.toLowerCase() === "o" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
}

function isSaveFileShortcut(event: KeyboardEvent): boolean {
    return event.key.toLowerCase() === "s" && (event.ctrlKey || event.metaKey) && !event.altKey;
}

function isSelectAllShortcut(event: KeyboardEvent): boolean {
    return event.key.toLowerCase() === "a" && (event.ctrlKey || event.metaKey);
}

function readInlineFormatShortcut(event: KeyboardEvent): InlineFormat | null {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) {
        return null;
    }

    const key = event.key.toLowerCase();
    if (key === "b") {
        return "bold";
    }

    if (key === "i") {
        return "italic";
    }

    return null;
}

function isPlainTextKey(event: KeyboardEvent): boolean {
    return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
}

function getElement<TElement extends HTMLElement>(id: string): TElement {
    const element = document.getElementById(id);
    if (!element) {
        throw new Error(`Missing element: ${id}`);
    }
    return element as TElement;
}
