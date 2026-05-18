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

type PointerBlockTarget = {
    block: HTMLElement;
    offset: number;
};

type BlockMarkdownSource = {
    prefix?: string;
    suffix?: string;
    atomic?: string;
};

type BlockMarkdownSourcePosition = "prefix" | "suffix" | "atomic";

type InlineFormat = "bold" | "italic";
type ZoomShortcut = "in" | "out" | "reset";

const caretSpacerCharacter = String.fromCharCode(8203);

const htmlEscapes: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};

let suppressSelectionChange = false;
let suppressedMarkdownTokenActivation: { block: HTMLElement; offset: number } | null = null;
let pendingHorizontalNavigationTarget: { token: HTMLElement; edge: MarkdownTokenEdge; requestId: number } | null = null;
let pendingHorizontalNavigationRequestId = 0;
let pendingVerticalLeadingTokenNavigationRequestId = 0;
let pendingVerticalLeadingTokenNavigationTarget: { requestId: number } | null = null;
let markdownReferences: MarkdownReferenceMap = {};
let indicatedActiveBlock: HTMLElement | null = null;
let markdownSourceRevealBlocks: HTMLElement[] = [];
let activeBlockMarkdownSource: { block: HTMLElement; rawBeforeActivation: string } | null = null;
let gutterHoverBlock: HTMLElement | null = null;
let gutterHoverTimer = 0;
let pointerDownSelectionStart: { x: number; y: number } | null = null;
let isPointerSelecting = false;
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
    window.addEventListener(documentStateChangedEvent, syncDocumentWindowTitle);
    bindDocumentActions({ loadDocument, serializeDocumentMarkdown });
    startDocumentAutosave();

    syncFirstBlockPlaceholder();
    syncDocumentWindowTitle();
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

function readZoomShortcut(event: KeyboardEvent): ZoomShortcut | null {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) {
        return null;
    }

    if (event.key === "+" || event.key === "=" || event.code === "NumpadAdd") {
        return "in";
    }

    if (event.key === "-" || event.key === "_" || event.code === "NumpadSubtract") {
        return "out";
    }

    if (event.key === "0" || event.code === "Numpad0") {
        return "reset";
    }

    return null;
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

function fileNameFromPath(path: string): string {
    const normalized = path.replace(/\\/g, "/");
    return normalized.slice(normalized.lastIndexOf("/") + 1) || path || "Untitled";
}

function handleTitleInput(): void {
    documentState.usesTitle = true;
    markDocumentDirty();
}

function handleDocumentSurfaceMouseDown(event: MouseEvent): void {
    if (isWindowChromeEvent(event)) {
        return;
    }

    if (event.button !== 0 || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
    }

    pointerDownSelectionStart = { x: event.clientX, y: event.clientY };
    setPointerSelecting(false);

    const target = event.target;
    if (!(target instanceof Element) || shouldLetBrowserHandlePointerTarget(target)) {
        return;
    }

    const pointerTarget = findPointerTargetBlock(target, event.clientX, event.clientY);
    if (!pointerTarget) {
        return;
    }

    event.preventDefault();
    focusBlockAtOffset(pointerTarget.block, pointerTarget.offset, { scroll: "minimal" });
}

function handleEditorMouseDown(event: MouseEvent): void {
    if (isWindowChromeEvent(event)) {
        return;
    }

    if (event.button !== 0 || event.detail < 3 || event.defaultPrevented) {
        return;
    }

    const block = findBlock(event.target);
    if (!block) {
        return;
    }

    event.preventDefault();
    selectBlockContents(block);
    syncActiveBlockIndicator(block);
}

function handleDocumentMouseMove(event: MouseEvent): void {
    if (isWindowChromeEvent(event)) {
        return;
    }

    if (!pointerDownSelectionStart || event.buttons !== 1) {
        return;
    }

    const deltaX = Math.abs(event.clientX - pointerDownSelectionStart.x);
    const deltaY = Math.abs(event.clientY - pointerDownSelectionStart.y);
    if (deltaX > 3 || deltaY > 3) {
        setPointerSelecting(true);
    }
}

function handleDocumentMouseUp(): void {
    pointerDownSelectionStart = null;
    window.requestAnimationFrame(() => {
        const selection = document.getSelection();
        setPointerSelecting(Boolean(selection && !selection.isCollapsed));
    });
}

function handleDocumentSurfaceMouseMove(event: MouseEvent): void {
    if (isWindowChromeEvent(event)) {
        return;
    }

    syncLinkOpenIntentFromMouse(event);
    scheduleGutterHover(event);
}

function handleDocumentSurfaceMouseOver(event: MouseEvent): void {
    if (isWindowChromeEvent(event)) {
        return;
    }

    syncLinkOpenIntentFromMouse(event);
}

function handleDocumentSurfaceMouseOut(event: MouseEvent): void {
    if (!(event.relatedTarget instanceof Element) || !getElement<HTMLElement>("document-surface").contains(event.relatedTarget)) {
        clearLinkOpenIntent();
    }
}

function isWindowChromeEvent(event: MouseEvent): boolean {
    return event.target instanceof Element && Boolean(event.target.closest(".windows-titlebar"));
}

function shouldLetBrowserHandlePointerTarget(target: Element): boolean {
    return Boolean(
        target.closest(
            "#document-title, .block-content, .todo-checkbox, button, input, textarea, select, [contenteditable='false']",
        ),
    );
}

function findPointerTargetBlock(target: Element, clientX: number, clientY: number): PointerBlockTarget | null {
    const directBlock = findBlock(target);
    if (directBlock) {
        return {
            block: directBlock,
            offset: getPointerCaretOffset(directBlock, clientX, clientY),
        };
    }

    const blocks = getEditorBlocks();
    if (blocks.length === 0) {
        return null;
    }

    const firstBlock = blocks[0];
    const firstRect = firstBlock.getBoundingClientRect();
    if (clientY < firstRect.top) {
        return { block: firstBlock, offset: 0 };
    }

    let previousBlock = firstBlock;
    for (const block of blocks) {
        const rect = block.getBoundingClientRect();

        if (clientY >= rect.top && clientY <= rect.bottom) {
            return {
                block,
                offset: getPointerCaretOffset(block, clientX, clientY),
            };
        }

        if (clientY < rect.top) {
            const previousRect = previousBlock.getBoundingClientRect();
            const gapProgress = (clientY - previousRect.bottom) / Math.max(1, rect.top - previousRect.bottom);
            if (gapProgress > 0.55) {
                return { block, offset: 0 };
            }

            return { block: previousBlock, offset: getBlockText(previousBlock).length };
        }

        previousBlock = block;
    }

    const trailingBlock = ensurePointerTrailingParagraph();
    return { block: trailingBlock, offset: 0 };
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
    const rect = content.getBoundingClientRect();
    const clampedX = clamp(clientX, rect.left + 1, rect.right - 1);
    const clampedY = clamp(clientY, rect.top + 1, rect.bottom - 1);
    const caretPosition = getCaretPositionFromPoint(clampedX, clampedY);

    if (caretPosition && (caretPosition.node === content || content.contains(caretPosition.node))) {
        return getCaretOffset(content, caretPosition.node, caretPosition.offset);
    }

    if (clientY < rect.top || clientX <= rect.left) {
        return 0;
    }

    return getBlockText(block).length;
}

function clamp(value: number, min: number, max: number): number {
    if (max < min) {
        return min;
    }

    return Math.min(Math.max(value, min), max);
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

function setPointerSelecting(selecting: boolean): void {
    if (isPointerSelecting === selecting) {
        return;
    }

    isPointerSelecting = selecting;
    getElement<HTMLElement>("editor").dataset.selecting = selecting ? "true" : "false";

    if (selecting) {
        clearGutterHoverBlock();
    }
}

function scheduleGutterHover(event: MouseEvent): void {
    if (isPointerSelecting) {
        clearGutterHoverBlock();
        return;
    }

    const block = findGutterHoverBlock(event.clientX, event.clientY);
    if (!block) {
        clearGutterHoverBlock();
        return;
    }

    if (gutterHoverBlock === block) {
        return;
    }

    if (gutterHoverTimer) {
        window.clearTimeout(gutterHoverTimer);
    }

    gutterHoverTimer = window.setTimeout(() => {
        gutterHoverTimer = 0;
        syncGutterHoverBlock(block);
    }, 220);
}

function findGutterHoverBlock(clientX: number, clientY: number): HTMLElement | null {
    for (const block of getEditorBlocks()) {
        const blockRect = block.getBoundingClientRect();
        if (clientY < blockRect.top || clientY > blockRect.bottom) {
            continue;
        }

        const contentRect = getBlockContent(block).getBoundingClientRect();
        if (clientX >= contentRect.left - 34 && clientX <= contentRect.left - 4) {
            return block;
        }
    }

    return null;
}

function syncGutterHoverBlock(block: HTMLElement | null): void {
    const nextBlock = block?.isConnected ? block : null;
    if (gutterHoverBlock === nextBlock) {
        return;
    }

    clearGutterHoverBlock();
    gutterHoverBlock = nextBlock;

    if (gutterHoverBlock) {
        gutterHoverBlock.dataset.gutterHover = "true";
    }
}

function clearGutterHoverBlock(): void {
    if (gutterHoverTimer) {
        window.clearTimeout(gutterHoverTimer);
        gutterHoverTimer = 0;
    }

    if (!gutterHoverBlock) {
        return;
    }

    delete gutterHoverBlock.dataset.gutterHover;
    gutterHoverBlock = null;
}

function syncLinkOpenIntentFromKeyboard(event: KeyboardEvent): void {
    getElement<HTMLElement>("editor").dataset.linkOpenIntent = event.ctrlKey || event.metaKey ? "true" : "false";
}

function syncLinkOpenIntentFromMouse(event: MouseEvent): void {
    const target = event.target;
    const hasLinkIntent = target instanceof Element && Boolean(target.closest("a.markdown-link")) && (event.ctrlKey || event.metaKey);

    getElement<HTMLElement>("editor").dataset.linkOpenIntent = hasLinkIntent ? "true" : "false";
}

function clearLinkOpenIntent(): void {
    getElement<HTMLElement>("editor").dataset.linkOpenIntent = "false";
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

function handleEditorClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) {
        return;
    }

    const selection = document.getSelection();
    if ((selection && !selection.isCollapsed) || event.detail > 1) {
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
    const focusBlock = findBlock(focusNode ?? null);
    syncActiveBlockIndicator(focusBlock);
    syncActiveBlockMarkdownSource(focusBlock);

    if (selection && !selection.isCollapsed) {
        syncBlockMarkdownSourceReveal(null);
        pendingHorizontalNavigationTarget = null;
        pendingVerticalLeadingTokenNavigationTarget = null;
        setPointerSelecting(true);
        return;
    }

    syncBlockMarkdownSourceReveal(focusBlock);

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
        codeFence: readBlockCodeFence(block),
        codeInfo: block.dataset.codeInfo,
        listMarker: readBlockListMarker(block),
        listNumber: readBlockListNumber(block),
        quoteLevel: readBlockQuoteLevel(block),
        ruleMarker: readBlockRuleMarker(block),
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

    if (isCompositionEvent(event)) {
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
    if (!source || source.textContent !== "" || event.inputType !== "insertText" || !event.data) {
        return;
    }

    event.preventDefault();
    source.textContent = event.data;
    focusPlainTextElement(source, event.data.length);
    markEditorDirty();
}

function handleBlockMarkdownSourceKeydown(event: KeyboardEvent): boolean {
    const source = getFocusedBlockMarkdownSource();
    if (!source) {
        return false;
    }

    pendingHorizontalNavigationTarget = null;
    pendingVerticalLeadingTokenNavigationTarget = null;

    if (
        (event.key === "Backspace" && isCaretAtPlainTextEdge(source, "start")) ||
        (event.key === "Delete" && isCaretAtPlainTextEdge(source, "end"))
    ) {
        event.preventDefault();
        return true;
    }

    if (deleteLastBlockMarkdownSourceCharacter(event, source)) {
        event.preventDefault();
        markEditorDirty();
        return true;
    }

    if (event.key === "Enter" && moveCaretAfterCodeBlockSource(source)) {
        event.preventDefault();
        markEditorDirty();
        return true;
    }

    if (event.key === "Enter" && splitAfterBlockMarkdownSource(source)) {
        event.preventDefault();
        markEditorDirty();
        return true;
    }

    if (event.key === "Enter" || readInlineFormatShortcut(event)) {
        event.preventDefault();
    }

    return true;
}

function deleteLastBlockMarkdownSourceCharacter(event: KeyboardEvent, source: HTMLElement): boolean {
    if (event.key !== "Backspace" && event.key !== "Delete") {
        return false;
    }

    const text = source.textContent ?? "";
    if (text.length !== 1) {
        return false;
    }

    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    if (!selection?.isCollapsed || !focusNode || (focusNode !== source && !source.contains(focusNode))) {
        return false;
    }

    const offset = getPlainTextBoundaryOffset(source, focusNode, selection.focusOffset);
    const isDeletingCharacter =
        (event.key === "Backspace" && offset === text.length) || (event.key === "Delete" && offset === 0);
    if (!isDeletingCharacter) {
        return false;
    }

    source.textContent = "";
    focusPlainTextElement(source, 0);
    return true;
}

function moveCaretIntoCodeBlockSourceAtBoundary(event: KeyboardEvent, block: HTMLElement): boolean {
    if (
        readBlockType(block.dataset.type) !== "code" ||
        block.dataset.markdownSourceActive !== "true" ||
        (event.key !== "Backspace" && event.key !== "Delete")
    ) {
        return false;
    }

    if (event.key === "Backspace" && isCaretAtBlockEdge(block, "start")) {
        return focusBlockMarkdownSource(block, "prefix", "end");
    }

    if (event.key === "Delete" && isCaretAtBlockEdge(block, "end")) {
        return focusBlockMarkdownSource(block, "suffix", "start");
    }

    return false;
}

function focusBlockMarkdownSource(
    block: HTMLElement,
    position: BlockMarkdownSourcePosition,
    edge: "start" | "end",
): boolean {
    const source = getBlockContent(block).querySelector<HTMLElement>(`.markdown-block-source-${position}`);
    if (!source) {
        return false;
    }

    focusPlainTextElement(source, edge === "start" ? 0 : (source.textContent ?? "").length);
    return true;
}

function focusPlainTextElement(element: HTMLElement, offset: number): void {
    const selection = document.getSelection();
    const range = document.createRange();
    const text = element.firstChild ?? element.appendChild(document.createTextNode(""));

    range.setStart(text, Math.min(Math.max(0, offset), text.textContent?.length ?? 0));
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
}

function splitAfterBlockMarkdownSource(source: HTMLElement): boolean {
    const block = findBlock(source);
    if (!block || readBlockType(block.dataset.type) === "code") {
        return false;
    }

    commitActiveBlockMarkdownSource(null);

    const type = readBlockType(block.dataset.type);
    if (type === "code") {
        focusBlockAtOffset(block, 0, { scroll: "none" });
        return true;
    }

    if (type === "rule") {
        ensureEditableBlockAfter(block);
        focusBlockAtOffset(getSiblingBlock(block, "next") ?? block, 0);
        return true;
    }

    focusBlockAtOffset(block, getBlockText(block).length, { scroll: "none" });
    splitBlock(block);
    return true;
}

function moveCaretAfterCodeBlockSource(source: HTMLElement): boolean {
    const block = findBlock(source);
    if (
        !block ||
        readBlockType(block.dataset.type) !== "code" ||
        !source.classList.contains("markdown-block-source-suffix") ||
        !isCaretAtPlainTextEdge(source, "end")
    ) {
        return false;
    }

    commitActiveBlockMarkdownSource(null);
    ensureEditableBlockAfter(block);
    focusBlockAtOffset(getSiblingBlock(block, "next") ?? block, 0);
    return true;
}

function moveCaretAfterCodeBlockSourceAtSelection(block: HTMLElement): boolean {
    if (readBlockType(block.dataset.type) !== "code" || !isCaretAfterCodeBlockSuffixSource(block)) {
        return false;
    }

    commitActiveBlockMarkdownSource(null);
    ensureEditableBlockAfter(block);
    focusBlockAtOffset(getSiblingBlock(block, "next") ?? block, 0);
    return true;
}

function isCaretAfterCodeBlockSuffixSource(block: HTMLElement): boolean {
    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    const content = getBlockContent(block);
    const suffix = content.querySelector<HTMLElement>(".markdown-block-source-suffix");

    if (!selection?.isCollapsed || !focusNode || !suffix) {
        return false;
    }

    if (getFocusedBlockMarkdownSource() === suffix) {
        return isCaretAtPlainTextEdge(suffix, "end");
    }

    if (focusNode !== content) {
        return false;
    }

    const suffixIndex = Array.from(content.childNodes).findIndex((child) => child === suffix);
    return suffixIndex >= 0 && selection.focusOffset > suffixIndex;
}

function isCaretAtPlainTextEdge(element: HTMLElement, edge: "start" | "end"): boolean {
    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    if (!selection?.isCollapsed || !focusNode || (focusNode !== element && !element.contains(focusNode))) {
        return false;
    }

    const offset = getPlainTextBoundaryOffset(element, focusNode, selection.focusOffset);
    return edge === "start" ? offset === 0 : offset === (element.textContent ?? "").length;
}

function trackVerticalBlockSourceNavigation(event: KeyboardEvent, block: HTMLElement): boolean {
    if (
        (event.key !== "ArrowUp" && event.key !== "ArrowDown") ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
    ) {
        return false;
    }

    const direction = event.key === "ArrowUp" ? "previous" : "next";
    const edge = direction === "previous" ? "start" : "end";
    if (!isCaretAtBlockEdge(block, edge)) {
        return false;
    }

    const target = getSiblingBlock(block, direction);
    if (target && hasBlockMarkdownSource(readBlockType(target.dataset.type))) {
        syncBlockMarkdownSourceReveal(target);

        if (direction === "previous" && getBlockText(block) === "") {
            event.preventDefault();
            focusBlockAtOffset(target, getBlockText(target).length, { scroll: "minimal" });
            return true;
        }
    }

    return false;
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

    if (isCompositionEvent(event)) {
        markDocumentDirty();
        return;
    }

    if (getFocusedBlockMarkdownSource()) {
        markEditorDirty();
        return;
    }

    if (isEditingMarkdownTokenSource()) {
        normalizeActiveMarkdownTokenSource(block);
        markEditorDirty();
        return;
    }

    if (rerenderPlainTextBlockMarkdownSource(block)) {
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

function syncActiveBlockMarkdownSource(focusBlock: HTMLElement | null): void {
    const source = getFocusedBlockMarkdownSource();
    const sourceBlock = source ? findBlock(source) : null;

    if (source && sourceBlock) {
        if (activeBlockMarkdownSource?.block !== sourceBlock) {
            activeBlockMarkdownSource = {
                block: sourceBlock,
                rawBeforeActivation: getBlockRawMarkdown(sourceBlock),
            };
        }
        return;
    }

    commitActiveBlockMarkdownSource(focusBlock);
}

function commitActiveBlockMarkdownSource(focusBlock: HTMLElement | null = findBlock(document.getSelection()?.focusNode ?? null)): void {
    const active = activeBlockMarkdownSource;
    activeBlockMarkdownSource = null;

    if (!active?.block.isConnected) {
        return;
    }

    const rawMarkdown = getBlockRawMarkdown(active.block);
    if (rawMarkdown === active.rawBeforeActivation) {
        return;
    }

    applyRawMarkdownToBlock(active.block, rawMarkdown, focusBlock);
}

function applyRawMarkdownToBlock(block: HTMLElement, rawMarkdown: string, focusBlock: HTMLElement | null): void {
    const parsedBlock = parseEditedRawMarkdownBlock(block, rawMarkdown);
    const selection = document.getSelection();
    const shouldRestoreFocus = focusBlock === block && selection?.focusNode && !getFocusedBlockMarkdownSource();
    const focusOffset = shouldRestoreFocus
        ? getCaretOffset(getBlockContent(block), selection.focusNode, selection.focusOffset)
        : null;

    applyBlockProperties(block, parsedBlock);
    setBlockText(block, parsedBlock.text);

    if (focusOffset !== null) {
        focusBlockAtOffset(block, Math.min(focusOffset, parsedBlock.text.length), { scroll: "none" });
    }
}

function parseEditedRawMarkdownBlock(block: HTMLElement, rawMarkdown: string): ParsedBlock {
    if (readBlockType(block.dataset.type) === "code") {
        const codeSource = readCodeBlockSourceParts(block);
        if (codeSource && !isValidCodeBlockSource(codeSource)) {
            return {
                type: "paragraph",
                text: serializeInvalidCodeBlockSource(codeSource),
            };
        }
    }

    const parsedBlocks = parseMarkdownFragment(rawMarkdown).blocks;
    return parsedBlocks.length === 1 ? parsedBlocks[0] : { type: "paragraph", text: rawMarkdown };
}

function getFocusedBlockMarkdownSource(): HTMLElement | null {
    const focusNode = document.getSelection()?.focusNode;
    const focusElement = focusNode instanceof Element ? focusNode : focusNode?.parentElement;

    return focusElement?.closest<HTMLElement>(".markdown-block-source") ?? null;
}

function getBlockRawMarkdown(block: HTMLElement): string {
    if (readBlockType(block.dataset.type) === "code") {
        return getCodeBlockRawMarkdown(block);
    }

    let text = "";

    for (const child of Array.from(getBlockContent(block).childNodes)) {
        text += isBlockMarkdownSource(child) ? child.textContent ?? "" : getMarkdownText(child);
    }

    return text;
}

function getCodeBlockRawMarkdown(block: HTMLElement): string {
    const source = readCodeBlockSourceParts(block);

    return source ? `${source.prefix}\n${source.text}\n${source.suffix}` : getMarkdownText(getBlockContent(block));
}

function readCodeBlockSourceParts(block: HTMLElement): { prefix: string; text: string; suffix: string } | null {
    const content = getBlockContent(block);
    const prefix = content.querySelector<HTMLElement>(".markdown-block-source-prefix");
    const body = content.querySelector<HTMLElement>(".markdown-code-block-body");
    const suffix = content.querySelector<HTMLElement>(".markdown-block-source-suffix");

    if (!prefix || !body || !suffix) {
        return null;
    }

    return {
        prefix: prefix.textContent ?? "",
        text: getMarkdownText(body),
        suffix: suffix.textContent ?? "",
    };
}

function isValidCodeBlockSource(source: { prefix: string; suffix: string }): boolean {
    const opening = source.prefix.trim().match(/^(`{3,}|~{3,})(.*)$/);
    if (!opening) {
        return false;
    }

    const marker = opening[1];
    const closing = source.suffix.trim();
    const markerCharacter = marker[0];

    return (
        closing.length >= marker.length &&
        closing.split("").every((character) => character === markerCharacter)
    );
}

function serializeInvalidCodeBlockSource(source: { prefix: string; text: string; suffix: string }): string {
    const lines = [source.prefix, source.text];
    if (source.suffix !== "") {
        lines.push(source.suffix);
    }

    return lines.join("\n");
}

function getPlainTextBoundaryOffset(current: Node, anchorNode: Node, anchorOffset: number): number {
    if (current === anchorNode) {
        if (current.nodeType === Node.TEXT_NODE) {
            return (current.textContent ?? "").slice(0, anchorOffset).length;
        }

        return Array.from(current.childNodes)
            .slice(0, Math.max(0, anchorOffset))
            .reduce((offset, child) => offset + (child.textContent ?? "").length, 0);
    }

    let offset = 0;
    for (const child of Array.from(current.childNodes)) {
        if (child === anchorNode || child.contains(anchorNode)) {
            return offset + getPlainTextBoundaryOffset(child, anchorNode, anchorOffset);
        }

        offset += (child.textContent ?? "").length;
    }

    return offset;
}

function isBlockMarkdownSource(node: Node): node is HTMLElement {
    return node instanceof HTMLElement && node.classList.contains("markdown-block-source");
}

function rerenderPlainTextBlockMarkdownSource(block: HTMLElement): boolean {
    if (readBlockType(block.dataset.type) !== "code") {
        return false;
    }

    const content = getBlockContent(block);
    const selection = document.getSelection();
    const offset =
        selection?.focusNode && (selection.focusNode === content || content.contains(selection.focusNode))
            ? getCaretOffset(content, selection.focusNode, selection.focusOffset)
            : getBlockText(block).length;
    const text = getBlockText(block);

    setBlockText(block, text);
    focusBlockAtOffset(block, Math.min(offset, text.length), { scroll: "none" });
    return true;
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

    applyBlockProperties(block, { ...options, type });
    setBlockText(block, text);
    return block;
}

function applyBlockProperties(block: HTMLElement, options: Partial<ParsedBlock> & { type: BlockType }): void {
    setBlockType(block, options.type);
    setBlockIndent(block, options.indent ?? 0);
    setBlockListMarker(block, options.listMarker);
    setBlockListNumber(block, options.listNumber);
    setBlockQuoteLevel(block, options.quoteLevel);
    setTodoChecked(block, options.checked ?? false);
    setCodeFence(block, options.codeFence);
    setCodeInfo(block, options.codeInfo ?? "");
    setRuleMarker(block, options.ruleMarker);
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
        delete block.dataset.codeFence;
        delete block.dataset.codeInfo;
    }

    if (type !== "rule") {
        delete block.dataset.ruleMarker;
    }

    if (type !== "quote") {
        delete block.dataset.quoteLevel;
    }
}

function setBlockText(block: HTMLElement, text: string): void {
    const content = getBlockContent(block);
    const type = readBlockType(block.dataset.type);
    const source = readBlockMarkdownSource(block, type, text);

    if (text !== "") {
        delete block.dataset.transient;
    }

    if (type === "code") {
        renderCodeBlockContent(content, text, source);
        delete content.dataset.renderedMarkdown;
        return;
    }

    if (isPlainTextBlockType(type)) {
        renderPlainTextBlockContent(content, text, source);
        delete content.dataset.renderedMarkdown;
        return;
    }

    if (isAtomicBlockType(type)) {
        renderAtomicBlockContent(content, source);
        delete content.dataset.renderedMarkdown;
        return;
    }

    const html =
        renderBlockMarkdownSourceHtml(source.prefix, "prefix") +
        renderInlineMarkdown(text, markdownReferences) +
        renderBlockMarkdownSourceHtml(source.suffix, "suffix");

    content.innerHTML = html;
    content.dataset.renderedMarkdown = html;
    hydrateMarkdownImagePreviews(content, documentState.activeFilePath);
}

function renderPlainTextBlockContent(content: HTMLElement, text: string, source: BlockMarkdownSource): void {
    content.replaceChildren();
    appendBlockMarkdownSourceElement(content, source.prefix, "prefix");
    content.append(document.createTextNode(text));
    appendBlockMarkdownSourceElement(content, source.suffix, "suffix");
}

function renderCodeBlockContent(content: HTMLElement, text: string, source: BlockMarkdownSource): void {
    content.replaceChildren();
    appendBlockMarkdownSourceElement(content, source.prefix, "prefix");
    appendCodeBlockBodyElement(content, text);
    appendBlockMarkdownSourceElement(content, source.suffix, "suffix");
}

function appendCodeBlockBodyElement(content: HTMLElement, text: string): void {
    const body = document.createElement("span");
    body.className = "markdown-code-block-body";
    body.append(document.createTextNode(renderCodeBlockBodyText(text)));
    content.append(body);
}

function renderCodeBlockBodyText(text: string): string {
    return text.endsWith("\n") ? `${text}${caretSpacerCharacter}` : text;
}

function renderAtomicBlockContent(content: HTMLElement, source: BlockMarkdownSource): void {
    content.replaceChildren();
    appendBlockMarkdownSourceElement(content, source.atomic ?? source.prefix, "atomic");
}

function appendBlockMarkdownSourceElement(
    content: HTMLElement,
    value: string | undefined,
    position: BlockMarkdownSourcePosition,
): void {
    if (!value) {
        return;
    }

    const source = document.createElement("span");
    source.className = `markdown-block-source markdown-block-source-${position}`;
    source.dataset.markdownIgnore = "true";
    source.spellcheck = false;
    source.textContent = value;
    content.append(source);
}

function renderBlockMarkdownSourceHtml(value: string | undefined, position: BlockMarkdownSourcePosition): string {
    if (!value) {
        return "";
    }

    return `<span class="markdown-block-source markdown-block-source-${position}" data-markdown-ignore="true" spellcheck="false">${escapeHtml(value)}</span>`;
}

function readBlockMarkdownSource(block: HTMLElement, type: BlockType, text: string): BlockMarkdownSource {
    if (headingTypes.has(type)) {
        return { prefix: `${"#".repeat(readHeadingLevel(type))} ` };
    }

    if (type === "list") {
        return { prefix: `${readBlockListMarker(block) ?? "-"} ` };
    }

    if (type === "ordered-list") {
        return { prefix: `${readBlockListNumber(block) ?? "1"}. ` };
    }

    if (type === "todo") {
        return { prefix: `${readBlockListMarker(block) ?? "-"} [${getTodoCheckbox(block).checked ? "x" : " "}] ` };
    }

    if (type === "quote") {
        const marker = ">".repeat(Math.max(1, readBlockQuoteLevel(block) ?? 1));
        return { prefix: `${marker} ` };
    }

    if (type === "code") {
        const fence = createCodeFence(text, readBlockCodeFence(block));
        const codeInfo = block.dataset.codeInfo ? ` ${block.dataset.codeInfo}` : "";
        return {
            prefix: `${fence}${codeInfo}`,
            suffix: fence,
        };
    }

    if (type === "rule") {
        return { atomic: readBlockRuleMarker(block) ?? "---" };
    }

    return {};
}

function hasBlockMarkdownSource(type: BlockType): boolean {
    return headingTypes.has(type) || ["list", "ordered-list", "todo", "quote", "code", "rule"].includes(type);
}

function readHeadingLevel(type: BlockType): number {
    return Number(type.slice("heading-".length)) || 1;
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

function setCodeFence(block: HTMLElement, codeFence: string | undefined): void {
    if (readBlockType(block.dataset.type) === "code" && codeFence && /^(`{3,}|~{3,})$/.test(codeFence)) {
        block.dataset.codeFence = codeFence;
        return;
    }

    delete block.dataset.codeFence;
}

function setCodeInfo(block: HTMLElement, codeInfo: string): void {
    if (readBlockType(block.dataset.type) === "code" && codeInfo) {
        block.dataset.codeInfo = codeInfo;
        return;
    }

    delete block.dataset.codeInfo;
}

function setRuleMarker(block: HTMLElement, ruleMarker: string | undefined): void {
    if (readBlockType(block.dataset.type) === "rule" && ruleMarker && /^(\*\s*){3,}$|^(-\s*){3,}$|^(_\s*){3,}$/.test(ruleMarker)) {
        block.dataset.ruleMarker = ruleMarker;
        return;
    }

    delete block.dataset.ruleMarker;
}

function getBlockText(block: HTMLElement): string {
    const content = getBlockContent(block);
    const type = readBlockType(block.dataset.type);

    if (isPlainTextBlockType(type)) {
        return getMarkdownText(content);
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

function readBlockCodeFence(block: HTMLElement): string | undefined {
    const codeFence = block.dataset.codeFence;
    return codeFence && /^(`{3,}|~{3,})$/.test(codeFence) ? codeFence : undefined;
}

function readNextListNumber(block: HTMLElement): string {
    const number = Number(readBlockListNumber(block) ?? "1");
    return Number.isFinite(number) ? String(number + 1) : "1";
}

function readBlockQuoteLevel(block: HTMLElement): number | undefined {
    const level = Number(block.dataset.quoteLevel ?? 1);
    return Number.isFinite(level) && level > 1 ? level : undefined;
}

function readBlockRuleMarker(block: HTMLElement): string | undefined {
    const ruleMarker = block.dataset.ruleMarker;
    return ruleMarker && /^(\*\s*){3,}$|^(-\s*){3,}$|^(_\s*){3,}$/.test(ruleMarker) ? ruleMarker : undefined;
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

function focusBlockAtOffset(block: HTMLElement, offset: number, options: { scroll?: "comfortable" | "minimal" | "none" } = {}): void {
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
    syncBlockMarkdownSourceReveal(block);
    if (options.scroll !== "none") {
        scrollBlockIntoComfortableView(block, options.scroll ?? "comfortable");
    }
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
    if (block?.isConnected && hasBlockMarkdownSource(readBlockType(block.dataset.type))) {
        targets.add(block);
    }
}

function scrollBlockIntoComfortableView(block: HTMLElement, mode: "comfortable" | "minimal"): void {
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
        const topInset = mode === "comfortable" ? Math.min(64, scrollerRect.height * 0.12) : 18;
        const bottomInset = mode === "comfortable" ? Math.min(112, scrollerRect.height * 0.2) : 36;
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

function readSelectedMarkdown(): string | null {
    const selectedRange = getSelectedBlockRange();
    if (!selectedRange) {
        return null;
    }

    const selectedBlocks = selectedRange.blocks.map((block) => readSelectedEditorBlock(block, selectedRange));
    const markdown = serializeMarkdownDocument("", false, selectedBlocks);

    return markdown.endsWith("\n") ? markdown.slice(0, -1) : markdown;
}

function readSelectedEditorBlock(block: HTMLElement, selectedRange: SelectedBlockRange): ParsedBlock {
    const text = getBlockText(block);
    const startOffset = block === selectedRange.startBlock ? selectedRange.startOffset : 0;
    const endOffset = block === selectedRange.endBlock ? selectedRange.endOffset : text.length;

    if (startOffset === 0 && endOffset === text.length) {
        return readEditorBlock(block);
    }

    return {
        type: "paragraph",
        text: text.slice(startOffset, endOffset),
    };
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

function selectBlockContents(block: HTMLElement): void {
    const content = getBlockContent(block);
    const selection = document.getSelection();
    const range = document.createRange();

    range.setStart(content, 0);
    range.setEnd(content, content.childNodes.length);
    selection?.removeAllRanges();
    selection?.addRange(range);
    setPointerSelecting(true);
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
    const source = readBlockMarkdownSource(block, type, text);
    const html =
        renderBlockMarkdownSourceHtml(source.prefix, "prefix") +
        renderInlineMarkdown(text, markdownReferences) +
        renderBlockMarkdownSourceHtml(source.suffix, "suffix");

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

function isCompositionEvent(event: Event): boolean {
    return (
        isComposingText ||
        (typeof InputEvent !== "undefined" && event instanceof InputEvent && event.isComposing) ||
        (typeof KeyboardEvent !== "undefined" &&
            event instanceof KeyboardEvent &&
            (event.isComposing || event.key === "Process"))
    );
}

function createCodeFence(text: string, preferredFence?: string): string {
    if (preferredFence && /^(`{3,}|~{3,})$/.test(preferredFence) && isCodeFenceSafe(text, preferredFence)) {
        return preferredFence;
    }

    const longestRun = text.match(/`+/g)?.reduce((longest, run) => Math.max(longest, run.length), 0) ?? 0;
    return "`".repeat(Math.max(3, longestRun + 1));
}

function isCodeFenceSafe(text: string, fence: string): boolean {
    const fenceCharacter = fence[0];
    const closingFence = fenceCharacter.repeat(fence.length);

    return !text.split("\n").some((line) => {
        const trimmed = line.trim();
        return trimmed.startsWith(closingFence) && trimmed.split("").every((character) => character === fenceCharacter);
    });
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (character) => htmlEscapes[character]);
}

function getElement<TElement extends HTMLElement>(id: string): TElement {
    const element = document.getElementById(id);
    if (!element) {
        throw new Error(`Missing element: ${id}`);
    }
    return element as TElement;
}
