import { Browser } from "@wailsio/runtime";
import {
    findAdjacentInactiveMarkdownToken,
    findMarkdownTokenAtCaret,
    findMarkdownTextPosition,
    getMarkdownBoundaryOffset,
    getMarkdownLengthBeforeChild,
    getMarkdownText,
    type MarkdownTokenEdge,
} from "../formats/markdown/dom";
import { parseMarkdownDocument, serializeMarkdownDocument } from "../formats/markdown/document";
import { hydrateMarkdownImagePreviews } from "../formats/markdown/images";
import { findFirstInlineToken, renderInlineMarkdown } from "../formats/markdown/inline";
import { markdownShortcuts } from "../formats/markdown/shortcuts";
import type { DocumentFile } from "../bridge/types";
import { bindDocumentActions, openDocument, startDocumentAutosave } from "../documents/document-actions";
import { documentState, markDocumentDirty } from "../documents/document-state";
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

export function installEditorController(): void {
    const editor = getElement<HTMLElement>("editor");
    const title = getElement<HTMLInputElement>("document-title");

    editor.addEventListener("keydown", handleEditorKeydown);
    editor.addEventListener("input", handleEditorInput);
    editor.addEventListener("paste", handleEditorPaste);
    editor.addEventListener("change", handleEditorChange);
    editor.addEventListener("click", handleEditorClick);
    title.addEventListener("input", handleTitleInput);
    document.addEventListener("selectionchange", handleSelectionChange);
    window.addEventListener("keydown", handleGlobalKeydown);
    bindDocumentActions({ loadDocument, serializeDocumentMarkdown });
    startDocumentAutosave();

    syncFirstBlockPlaceholder();
}

function handleGlobalKeydown(event: KeyboardEvent): void {
    if (!isOpenFileShortcut(event)) {
        return;
    }

    event.preventDefault();
    void openDocument();
}

function handleTitleInput(): void {
    documentState.usesTitle = true;
    markDocumentDirty();
}

function handleEditorChange(event: Event): void {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.classList.contains("todo-checkbox")) {
        markDocumentDirty();
    }
}

function handleEditorClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) {
        return;
    }

    const token = target.closest<HTMLElement>(".markdown-token");
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

function handleSelectionChange(): void {
    if (suppressSelectionChange) {
        return;
    }

    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    const focusElement = focusNode instanceof Element ? focusNode : focusNode?.parentElement;
    const source = focusElement?.closest<HTMLElement>(".markdown-token-source");

    const token = source?.closest<HTMLElement>(".markdown-token");
    if (source && token) {
        setActiveMarkdownToken(token);
        return;
    }

    if (selection?.isCollapsed && revealPendingHorizontalNavigationTarget()) {
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

    const tokenPosition = findMarkdownTokenAtCaret(focusNode, selection.focusOffset, isNavigableMarkdownToken);
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

function suppressSelectionChangeForFrame(): void {
    suppressSelectionChange = true;
    window.requestAnimationFrame(() => {
        suppressSelectionChange = false;
    });
}

function focusMarkdownTokenSource(token: HTMLElement, edge: "start" | "end" = "end"): void {
    const source = token.querySelector<HTMLElement>(".markdown-token-source");
    const selection = document.getSelection();
    const range = document.createRange();

    if (!source || !selection) {
        return;
    }

    const position = getTextPosition(source, edge === "start" ? 0 : source.textContent?.length ?? 0);

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
    return token.dataset.sourceBeforeActivation !== undefined && getMarkdownText(token) !== token.dataset.sourceBeforeActivation;
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
    title.value = parsedDocument.title;
    replaceEditorBlocks(parsedDocument.blocks);
    documentState.lastSavedMarkdown = serializeDocumentMarkdown();
    documentState.hasUnsavedChanges = false;
}

function serializeDocumentMarkdown(): string {
    const title = getElement<HTMLInputElement>("document-title").value;
    return serializeMarkdownDocument(title, documentState.usesTitle, getEditorBlocks().map(readEditorBlock));
}

function readEditorBlock(block: HTMLElement): ParsedBlock {
    const type = readBlockType(block.dataset.type);

    return {
        type,
        text: getBlockText(block),
        indent: readBlockIndent(block),
        checked: type === "todo" ? getTodoCheckbox(block).checked : undefined,
        codeInfo: block.dataset.codeInfo,
    };
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

    getBlockContent(firstBlock).dataset.placeholder = "Start writing";

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
            markDocumentDirty();
        }
        return;
    }

    if (moveCaretOutOfActiveMarkdownTokenSource(event, block)) {
        event.preventDefault();
        return;
    }

    trackHorizontalMarkdownNavigation(event);
    if (trackVerticalMarkdownImageNavigation(event, block)) {
        return;
    }

    if (event.key === "Tab" && indentListBlocks(block, event.shiftKey ? -1 : 1)) {
        event.preventDefault();
        markDocumentDirty();
        return;
    }

    if (event.key === "Enter") {
        event.preventDefault();
        if (readBlockType(block.dataset.type) === "code" && !event.ctrlKey && !event.metaKey) {
            replaceSelectionWithText(block, "\n");
            markDocumentDirty();
            return;
        }

        splitBlock(deleteSelectedContent() ?? block);
        markDocumentDirty();
        return;
    }

    if (event.key === "Backspace" || event.key === "Delete") {
        if (deleteSelectedContent()) {
            event.preventDefault();
            markDocumentDirty();
            return;
        }

        if (event.key === "Backspace" && removeOrMergeBackward(block)) {
            event.preventDefault();
            markDocumentDirty();
            return;
        }

        if (event.key === "Delete" && mergeForward(block)) {
            event.preventDefault();
            markDocumentDirty();
            return;
        }
    }

    if (isPlainTextKey(event) && getSelectedBlockRange()) {
        event.preventDefault();
        replaceSelectionWithText(block, event.key);
        markDocumentDirty();
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
    if (!token || !isNavigableMarkdownToken(token)) {
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
    activateMarkdownTokenSource(targetToken, direction === "previous" ? "end" : "start");
    return true;
}

function isNavigableMarkdownToken(token: HTMLElement): boolean {
    return (
        token.classList.contains("markdown-link-token") ||
        token.classList.contains("markdown-image-token") ||
        token.classList.contains("markdown-format-token")
    );
}

function handleEditorInput(event: Event): void {
    const block = getActiveBlock(event.target);
    if (!block) {
        return;
    }

    if (isEditingMarkdownTokenSource()) {
        normalizeActiveMarkdownTokenSource(block);
        markDocumentDirty();
        return;
    }

    if (!applyMarkdownShortcut(block)) {
        renderBlockContent(block);
    }

    markDocumentDirty();
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
    const token = source?.closest<HTMLElement>(".markdown-token");

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
    insertPastedText(block, text.replace(/\r\n?/g, "\n"));
    markDocumentDirty();
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
    const nextType = headingTypes.has(currentType) || currentType === "code" ? "paragraph" : currentType;
    const nextBlock = createBlock(nextType, after);

    setBlockText(block, before);
    block.after(nextBlock);
    setBlockIndent(nextBlock, nextType === "list" ? readBlockIndent(block) : 0);
    focusBlockAtOffset(nextBlock, 0);
}

function applyMarkdownShortcut(block: HTMLElement): boolean {
    const text = getBlockText(block);
    const shortcut = markdownShortcuts.find((candidate) => text.startsWith(candidate.marker));

    if (!shortcut) {
        return false;
    }

    setBlockType(block, shortcut.type);
    setBlockIndent(block, shortcut.indent ?? 0);
    setBlockText(block, text.slice(shortcut.marker.length));
    ensureEditableBlockAfter(block);
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
    setBlockText(block, text);
    setBlockIndent(block, options.indent ?? 0);
    setTodoChecked(block, options.checked ?? false);
    setCodeInfo(block, options.codeInfo ?? "");
    return block;
}

function setBlockType(block: HTMLElement, type: BlockType): void {
    block.dataset.type = type;
    getBlockContent(block).setAttribute("aria-label", `${blockLabels[type]} block`);

    if (type !== "list") {
        setBlockIndent(block, 0);
    }

    if (type !== "code") {
        delete block.dataset.codeInfo;
    }
}

function setBlockText(block: HTMLElement, text: string): void {
    const content = getBlockContent(block);

    if (readBlockType(block.dataset.type) === "code") {
        content.textContent = text;
        delete content.dataset.renderedMarkdown;
        return;
    }

    const html = renderInlineMarkdown(text);

    content.innerHTML = html;
    content.dataset.renderedMarkdown = html;
    hydrateMarkdownImagePreviews(content, documentState.activeFilePath);
}

function setBlockIndent(block: HTMLElement, indent: number): void {
    if (indent > 0) {
        block.dataset.indent = String(Math.min(indent, 3));
        return;
    }

    delete block.dataset.indent;
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

    if (readBlockType(block.dataset.type) === "code") {
        return content.textContent ?? "";
    }

    return getMarkdownText(content);
}

function readBlockIndent(block: HTMLElement): number {
    const indent = Number(block.dataset.indent ?? 0);
    return Number.isFinite(indent) ? indent : 0;
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

function getBoundaryOffset(
    block: HTMLElement,
    container: Node,
    offset: number,
    edge: "start" | "end",
): number {
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
    if (readBlockType(block.dataset.type) === "code") {
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
        if (readBlockType(block.dataset.type) === "code") {
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
    const lines = text.split("\n");

    if (readBlockType(selectedBlock.dataset.type) === "code" || lines.length === 1) {
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
    let currentBlock = selectedBlock;

    setBlockText(selectedBlock, before + lines[0]);

    for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        const isLastLine = lineIndex === lines.length - 1;
        const nextBlock = createBlock("paragraph", isLastLine ? line + after : line);

        currentBlock.after(nextBlock);
        currentBlock = nextBlock;
    }

    focusBlockAtOffset(currentBlock, lines[lines.length - 1].length);
}

function indentListBlocks(block: HTMLElement, delta: number): boolean {
    const selectedRange = getSelectedBlockRange();
    const blocks = selectedRange?.blocks ?? [block];
    const listBlocks = blocks.filter((candidate) => readBlockType(candidate.dataset.type) === "list");

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
    setCodeInfo(block, "");
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
        (child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains("markdown-image-token"),
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
        const distance =
            direction === "previous" ? caretRect.top - tokenRect.bottom : tokenRect.top - caretRect.bottom;

        if (distance < -1 || distance > maximumDistance) {
            continue;
        }

        const caretX = caretRect.left + caretRect.width / 2;
        const tokenX = tokenRect.left + tokenRect.width / 2;
        const horizontalDistance = Math.abs(caretX - tokenX);

        if (!best || distance < best.distance || (distance === best.distance && horizontalDistance < best.horizontalDistance)) {
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
    if (readBlockType(block.dataset.type) === "code") {
        return;
    }

    const content = getBlockContent(block);
    const selection = document.getSelection();
    const offset =
        selection?.focusNode && (selection.focusNode === content || content.contains(selection.focusNode))
            ? getCaretOffset(content, selection.focusNode, selection.focusOffset)
            : getBlockText(block).length;
    const text = getBlockText(block);
    const html = renderInlineMarkdown(text);

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
    return type === "list" || type === "todo";
}

function isOpenFileShortcut(event: KeyboardEvent): boolean {
    return event.key.toLowerCase() === "o" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
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
