import { Browser } from "@wailsio/runtime";
import {
    findMarkdownTokenAtCaret,
    getMarkdownBoundaryOffset,
    getMarkdownText,
} from "../dom";
import {
    findBlock,
    getBlockContent,
    getBlockText,
    getSiblingBlock,
    setBlockText,
} from "../../../editor/blocks/view";
import {
    focusBlockAtOffset,
    focusPlainTextElement,
    getCaretOffset,
    getCaretPositionFromPoint,
    getPlainTextBoundaryOffset,
    getTextPosition,
} from "../../../editor/selection/caret";
import { getElement } from "../../../utils/dom";
import { clamp } from "../../../utils/text";
import { setPointerSelecting } from "../../../editor/pointer-interactions";
import type { DocumentEditorSelectionState } from "../../types";

type MarkdownTokenMatcher = (token: HTMLElement) => boolean;

type MarkdownTokenHooks = {
    syncActiveBlockMarkdownSource?: (focusBlock: HTMLElement | null) => void;
};

const editingTokenClass = "markdown-token-editing";

let hooks: MarkdownTokenHooks = {};
let suppressSelectionChange = false;
let suppressedMarkdownTokenActivation: { block: HTMLElement; offset: number } | null = null;
let pendingClickRevealRequestId = 0;
let suppressCollapsedPointerReveal = false;
let suppressCollapsedPointerRevealTimer = 0;
let activeMarkdownTokens = new Set<HTMLElement>();
let selectedSourceMarkdownTokens = new Set<HTMLElement>();

export function configureMarkdownTokenController(nextHooks: MarkdownTokenHooks): void {
    hooks = { ...hooks, ...nextHooks };
}

export function handleEditorClick(event: MouseEvent): void {
    clearCollapsedPointerRevealSuppression();

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
        if (target.closest(`.${editingTokenClass}`)) {
            setActiveMarkdownToken(token);
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        const link = token.querySelector<HTMLAnchorElement>("a.markdown-link");
        const href = link?.dataset.href;
        if (href && (event.ctrlKey || event.metaKey)) {
            if (scrollToInternalMarkdownAnchor(href)) {
                return;
            }

            void Browser.OpenURL(href).catch((error) => console.error("Failed to open URL:", error));
            return;
        }

        activateMarkdownTokenSourceAtPoint(token, event.clientX, event.clientY);
        return;
    }

    const link = target.closest("a.markdown-link") as HTMLAnchorElement | null;
    const href = link?.dataset.href;
    if (!href) {
        scheduleClickCaretTokenReveal();
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    clearActiveMarkdownToken();

    if (event.ctrlKey || event.metaKey) {
        if (scrollToInternalMarkdownAnchor(href)) {
            return;
        }

        void Browser.OpenURL(href).catch((error) => console.error("Failed to open URL:", error));
    }
}

function scrollToInternalMarkdownAnchor(href: string): boolean {
    if (!href.startsWith("#") || href.length <= 1) {
        return false;
    }

    const id = decodeURIComponent(href.slice(1));
    const target = document.getElementById(id);
    if (!target) {
        return false;
    }

    target.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    return true;
}

export function handleEditorMouseDown(event: MouseEvent): boolean {
    if (
        event.button !== 0 ||
        event.defaultPrevented ||
        event.detail > 1 ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
    ) {
        return false;
    }

    const target = event.target;
    if (!(target instanceof Element) || target.closest(`.${editingTokenClass}`)) {
        return false;
    }

    if (findMarkdownTokenAtPoint(event.clientX, event.clientY, target, isEditableMarkdownToken)) {
        suppressCollapsedRevealForPointer();
    }

    return false;
}

function scheduleClickCaretTokenReveal(): void {
    const requestId = pendingClickRevealRequestId + 1;
    pendingClickRevealRequestId = requestId;

    window.requestAnimationFrame(() => {
        if (requestId !== pendingClickRevealRequestId) {
            return;
        }

        if (revealMarkdownTokenAtCaret()) {
            return;
        }

        clearActiveMarkdownToken();
    });
}

export function handleSelectionChange(selectionState: DocumentEditorSelectionState): void {
    if (suppressSelectionChange) {
        return;
    }

    const selection = selectionState.selection;
    const focusBlock = selectionState.focusBlock;
    hooks.syncActiveBlockMarkdownSource?.(focusBlock);

    if (selection && !selectionState.isCollapsed) {
        clearPendingMarkdownTokenNavigation();
        syncSelectedMarkdownTokenSources(selection);
        setPointerSelecting(true);
        return;
    }

    clearSelectedMarkdownTokenSources();

    const source = getFocusedMarkdownTokenSource();
    const sourceToken = source ? getMarkdownTokenForSource(source) : null;

    if (sourceToken) {
        if (selection && sourceToken.dataset.active !== "true" && shouldSuppressMarkdownTokenActivation(selection)) {
            return;
        }

        setActiveMarkdownToken(sourceToken);
        return;
    }

    if (clearActiveMarkdownToken({ suppressTokenActivationAtFocus: true })) {
        return;
    }

    if (selection?.isCollapsed && shouldSuppressMarkdownTokenActivation(selection)) {
        return;
    }

    if (
        selectionState.isCollapsed &&
        selectionState.focusNode &&
        suppressCollapsedPointerReveal &&
        findMarkdownTokenAtPosition(selectionState.focusNode, selectionState.focusOffset, isEditableMarkdownToken)
    ) {
        return;
    }

    if (
        selectionState.isCollapsed &&
        selectionState.focusNode &&
        activateMarkdownTokenAtPosition(selectionState.focusNode, selectionState.focusOffset, isEditableMarkdownToken)
    ) {
        return;
    }

    clearActiveMarkdownToken();
}

export function clearPendingMarkdownTokenNavigation(): void {
}

export function commitActiveMarkdownTokenSource(): void {
    clearActiveMarkdownToken({ suppressTokenActivationAtFocus: true });
}

export function getFocusedMarkdownTokenSource(): HTMLElement | null {
    const focusNode = document.getSelection()?.focusNode;
    const focusElement = focusNode instanceof Element ? focusNode : focusNode?.parentElement;
    const source = focusElement?.closest<HTMLElement>(`.${editingTokenClass}`) ?? null;

    return source && source.dataset.active === "true" && !isMarkdownTokenSourceInsideIgnoredContent(source)
        ? source
        : null;
}

export function readSelectedMarkdownTokenSourceText(): string | null {
    const range = readSelectedMarkdownTokenSourceRange();
    if (!range) {
        return null;
    }

    return (range.source.textContent ?? "").slice(range.startOffset, range.endOffset);
}

export function deleteSelectedMarkdownTokenSourceText(): boolean {
    const range = readSelectedMarkdownTokenSourceRange();
    if (!range) {
        return false;
    }

    replaceMarkdownTokenSourceRange(range, "");
    return true;
}

export function insertTextIntoFocusedMarkdownTokenSource(text: string): boolean {
    const target = readFocusedMarkdownTokenSourceTarget();
    if (!target) {
        return false;
    }

    replaceMarkdownTokenSourceRange(target, text);
    return true;
}

function setActiveMarkdownToken(token: HTMLElement): HTMLElement | null {
    if (!isEditableMarkdownToken(token)) {
        return null;
    }

    if (token.dataset.active === "true" && token.classList.contains(editingTokenClass)) {
        activeMarkdownTokens.add(token);
        return token;
    }

    const raw = token.dataset.sourceRaw ?? getMarkdownText(token);
    token.dataset.sourceBeforeActivation = raw;
    token.dataset.active = "true";
    delete token.dataset.sourceRaw;
    token.classList.add(editingTokenClass);
    token.contentEditable = "true";
    token.spellcheck = false;
    token.replaceChildren(document.createTextNode(raw));
    activeMarkdownTokens.add(token);
    return token;
}

function activateMarkdownTokenSource(
    token: HTMLElement,
    edge: "start" | "end" = "end",
    options: { advanceIntoSource?: boolean } = {},
): void {
    const source = setActiveMarkdownToken(token);
    if (!source) {
        return;
    }

    suppressSelectionChangeForFrame();
    focusMarkdownTokenSource(source, edge, options);
}

function activateMarkdownTokenSourceAtPoint(
    token: HTMLElement,
    clientX: number,
    clientY: number,
    fallbackEdge: "start" | "end" = "end",
): void {
    const renderedEdge = token.dataset.active === "true" ? null : readRenderedTokenClickEdge(token, clientX);

    const source = setActiveMarkdownToken(token);
    if (!source) {
        return;
    }

    suppressSelectionChangeForFrame();

    if (renderedEdge) {
        focusMarkdownTokenSource(source, renderedEdge);
        return;
    }

    if (focusMarkdownTokenSourceAtPoint(source, clientX, clientY)) {
        return;
    }

    focusMarkdownTokenSource(source, fallbackEdge);
}

export function activateMarkdownTokenAtCaret(): boolean {
    const selection = document.getSelection();
    const focusNode = selection?.focusNode;

    if (!selection?.isCollapsed || !focusNode) {
        return false;
    }

    if (shouldSuppressMarkdownTokenActivation(selection)) {
        return false;
    }

    return activateMarkdownTokenAtPosition(focusNode, selection.focusOffset);
}

export function revealMarkdownTokenAtCaret(): boolean {
    const selection = document.getSelection();
    const focusNode = selection?.focusNode;

    if (!selection?.isCollapsed || !focusNode) {
        return false;
    }

    if (shouldSuppressMarkdownTokenActivation(selection)) {
        return false;
    }

    return revealMarkdownTokenAtPosition(focusNode, selection.focusOffset);
}

export function focusMarkdownTokenSourceSelection(token: HTMLElement, offset: number): boolean {
    const source = setActiveMarkdownToken(token);
    if (!source) {
        return false;
    }

    suppressSelectionChangeForFrame();
    focusMarkdownTokenSourceAtOffset(source, Math.min(offset, source.textContent?.length ?? 0));
    return true;
}

function activateMarkdownTokenAtPosition(
    node: Node,
    offset: number,
    isTokenMatch: MarkdownTokenMatcher = isAutoActivatableMarkdownToken,
): boolean {
    if (isPositionInActiveMarkdownToken(node)) {
        return true;
    }

    const tokenPosition = findMarkdownTokenAtCaret(node, offset, isTokenMatch);
    if (!tokenPosition) {
        return false;
    }

    activateMarkdownTokenSource(tokenPosition.token, tokenPosition.edge);
    return true;
}

function revealMarkdownTokenAtPosition(
    node: Node,
    offset: number,
    isTokenMatch: MarkdownTokenMatcher = isEditableMarkdownToken,
): boolean {
    if (isPositionInActiveMarkdownToken(node)) {
        return true;
    }

    const tokenPosition = findMarkdownTokenAtCaret(node, offset, isTokenMatch);
    if (!tokenPosition) {
        return false;
    }

    activateMarkdownTokenSource(tokenPosition.token, tokenPosition.edge);
    return true;
}

function findMarkdownTokenAtPoint(
    clientX: number,
    clientY: number,
    target: Element,
    isTokenMatch: MarkdownTokenMatcher,
): { token: HTMLElement; node: Node; offset: number } | null {
    const position = getCaretPositionFromPoint(clientX, clientY);
    if (position) {
        const tokenPosition = findMarkdownTokenAtPosition(position.node, position.offset, isTokenMatch);
        if (tokenPosition) {
            return { ...tokenPosition, node: position.node, offset: position.offset };
        }
    }

    const block = findPointBlock(target, clientX, clientY);
    return block ? findMarkdownTokenAtBlockPoint(block, clientX, clientY, isTokenMatch) : null;
}

function findMarkdownTokenAtPosition(
    node: Node,
    offset: number,
    isTokenMatch: MarkdownTokenMatcher,
): { token: HTMLElement; edge: "start" | "end" } | null {
    return findMarkdownTokenAtCaret(node, offset, isTokenMatch);
}

function isPositionInActiveMarkdownToken(node: Node): boolean {
    return findActiveMarkdownTokenAtPosition(node) !== null;
}

function findActiveMarkdownTokenAtPosition(node: Node): HTMLElement | null {
    const element = node instanceof Element ? node : node.parentElement;
    const token = element?.closest<HTMLElement>(".markdown-token");

    return token?.dataset.active === "true" && token.classList.contains(editingTokenClass) ? token : null;
}

function findPointBlock(target: Element, clientX: number, clientY: number): HTMLElement | null {
    const targetBlock = findBlock(target);
    if (targetBlock) {
        return targetBlock;
    }

    const pointTarget = document.elementFromPoint(clientX, clientY);
    return pointTarget instanceof Element ? findBlock(pointTarget) : null;
}

function findMarkdownTokenAtBlockPoint(
    block: HTMLElement,
    clientX: number,
    clientY: number,
    isTokenMatch: MarkdownTokenMatcher,
): { token: HTMLElement; node: Node; offset: number } | null {
    const content = getBlockContent(block);
    const rect = content.getBoundingClientRect();

    if (clientY < rect.top || clientY > rect.bottom) {
        return null;
    }

    const clampedX = clamp(clientX, rect.left + 1, rect.right - 1);
    const clampedY = clamp(clientY, rect.top + 1, rect.bottom - 1);
    const position = getCaretPositionFromPoint(clampedX, clampedY);
    if (position && (position.node === content || content.contains(position.node))) {
        const offset = getCaretOffset(content, position.node, position.offset);
        return findMarkdownTokenAtBlockOffset(content, offset, isTokenMatch);
    }

    if (clientX <= rect.left) {
        return findMarkdownTokenAtBlockOffset(content, 0, isTokenMatch);
    }

    return findMarkdownTokenAtBlockOffset(content, getBlockText(block).length, isTokenMatch);
}

function findMarkdownTokenAtBlockOffset(
    content: HTMLElement,
    offset: number,
    isTokenMatch: MarkdownTokenMatcher,
): { token: HTMLElement; node: Node; offset: number } | null {
    const position = getTextPosition(content, offset);
    const tokenPosition = findMarkdownTokenAtPosition(position.node, position.offset, isTokenMatch);
    return tokenPosition ? { ...tokenPosition, node: position.node, offset: position.offset } : null;
}

function clearActiveMarkdownToken(
    options: {
        focusBlock?: HTMLElement;
        focusOffset?: number;
        suppressTokenActivationAtFocus?: boolean;
    } = {},
): boolean {
    const activeTokens = getActiveMarkdownTokens();

    if (activeTokens.length === 0) {
        return false;
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
        };
    });

    for (const update of updates) {
        setBlockText(update.block, update.text);
    }

    activeMarkdownTokens.clear();

    if (selectionBlock?.isConnected && selectionOffset !== null) {
        const focusOffset = Math.min(selectionOffset, getBlockText(selectionBlock).length);

        if (options.suppressTokenActivationAtFocus) {
            suppressedMarkdownTokenActivation = { block: selectionBlock, offset: focusOffset };
        }

        suppressSelectionChangeForFrame();
        focusBlockAtOffset(selectionBlock, focusOffset);
    }

    return true;
}

function isEditableMarkdownToken(token: HTMLElement): boolean {
    return token.dataset.sourceRaw !== undefined || token.classList.contains(editingTokenClass);
}

function isAutoActivatableMarkdownToken(token: HTMLElement): boolean {
    return isEditableMarkdownToken(token) && !isFormatMarkdownToken(token);
}

function getMarkdownTokenForSource(source: HTMLElement): HTMLElement | null {
    if (source.classList.contains("markdown-token")) {
        return source;
    }

    const parent = source.parentElement;
    return parent instanceof HTMLElement && parent.classList.contains("markdown-token") ? parent : null;
}

function isFormatMarkdownToken(token: HTMLElement): boolean {
    return token.classList.contains("markdown-format-token");
}

function readMarkdownTokenRawText(token: HTMLElement): string {
    return token.dataset.sourceRaw ?? token.textContent ?? "";
}

function isMarkdownTokenSourceInsideIgnoredContent(source: HTMLElement): boolean {
    const ignored = source.parentElement?.closest("[data-source-ignore='true']");
    return Boolean(ignored && !ignored.contains(source));
}

export function moveCaretOutOfActiveMarkdownTokenSourceVertically(event: KeyboardEvent, block: HTMLElement): boolean {
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
    const source = getFocusedMarkdownTokenSource();
    const token = source ? getMarkdownTokenForSource(source) : null;

    if (!selection?.isCollapsed || !focusNode || !source || token?.dataset.active !== "true") {
        return false;
    }

    const sibling = getSiblingBlock(block, event.key === "ArrowUp" ? "previous" : "next");
    if (!sibling) {
        return false;
    }

    const blockOffset = getCaretOffset(getBlockContent(block), focusNode, selection.focusOffset);
    const targetOffset = Math.min(blockOffset, getBlockText(sibling).length);
    event.preventDefault();
    clearActiveMarkdownToken({
        focusBlock: sibling,
        focusOffset: targetOffset,
    });
    return true;
}

export function moveCaretAfterActiveDisplayMathTokenSource(event: KeyboardEvent, block: HTMLElement): boolean {
    if (event.key !== "Enter" || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return false;
    }

    const source = getFocusedMarkdownTokenSource();
    const token = source ? getMarkdownTokenForSource(source) : null;
    if (!source || !token?.classList.contains("markdown-display-math-token")) {
        return false;
    }

    const tokenEndOffset = getMarkdownBoundaryOffset(getBlockContent(block), token, token.childNodes.length);
    clearActiveMarkdownToken({
        focusBlock: block,
        focusOffset: tokenEndOffset,
        suppressTokenActivationAtFocus: true,
    });
    return true;
}

export function suppressAdjacentFormatTokenActivation(block: HTMLElement, offset: number): boolean {
    const content = getBlockContent(block);
    const position = getTextPosition(content, offset);
    const tokenPosition = findMarkdownTokenAtCaret(position.node, position.offset, isFormatMarkdownToken);

    if (tokenPosition) {
        if (activateFormatMarkdownTokenSourceAtOffset(content, tokenPosition.token, offset)) {
            return true;
        }

        suppressedMarkdownTokenActivation = { block, offset };
        return true;
    }

    return false;
}

type MarkdownTokenSourceRange = {
    source: HTMLElement;
    startOffset: number;
    endOffset: number;
};

function readFocusedMarkdownTokenSourceTarget(): MarkdownTokenSourceRange | null {
    const selectedRange = readSelectedMarkdownTokenSourceRange();
    if (selectedRange) {
        return selectedRange;
    }

    const source = getFocusedMarkdownTokenSource();
    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    if (!source || !selection?.isCollapsed || !focusNode || (focusNode !== source && !source.contains(focusNode))) {
        return null;
    }

    const offset = getPlainTextBoundaryOffset(source, focusNode, selection.focusOffset);
    return { source, startOffset: offset, endOffset: offset };
}

function replaceMarkdownTokenSourceRange(range: MarkdownTokenSourceRange, text: string): void {
    const currentText = range.source.textContent ?? "";
    const token = getMarkdownTokenForSource(range.source);

    if (token) {
        setActiveMarkdownToken(token);
    }

    range.source.textContent =
        currentText.slice(0, range.startOffset) + text + currentText.slice(range.endOffset);
    focusPlainTextElement(range.source, range.startOffset + text.length);
}

function readSelectedMarkdownTokenSourceRange(): MarkdownTokenSourceRange | null {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return null;
    }

    const range = selection.getRangeAt(0);
    const startBoundary = readSelectedMarkdownTokenSourceBoundary(
        range.startContainer,
        range.startOffset,
        "start",
    );
    const endBoundary = readSelectedMarkdownTokenSourceBoundary(range.endContainer, range.endOffset, "end");
    if (!startBoundary || !endBoundary || startBoundary.source !== endBoundary.source) {
        return null;
    }

    return {
        source: startBoundary.source,
        startOffset: Math.min(startBoundary.offset, endBoundary.offset),
        endOffset: Math.max(startBoundary.offset, endBoundary.offset),
    };
}

function readSelectedMarkdownTokenSourceBoundary(
    node: Node,
    offset: number,
    edge: "start" | "end",
): { source: HTMLElement; offset: number } | null {
    const containingSource = findContainingMarkdownTokenSource(node);
    if (containingSource) {
        return {
            source: containingSource,
            offset: getPlainTextBoundaryOffset(containingSource, node, offset),
        };
    }

    const adjacentSource = findAdjacentSelectedMarkdownTokenSource(node, offset, edge);
    if (!adjacentSource) {
        return null;
    }

    return {
        source: adjacentSource,
        offset: edge === "start" ? 0 : adjacentSource.textContent?.length ?? 0,
    };
}

function findContainingMarkdownTokenSource(node: Node | null): HTMLElement | null {
    if (!node) {
        return null;
    }

    const element = node instanceof Element ? node : node.parentElement;
    const source = element?.closest<HTMLElement>(`.${editingTokenClass}`) ?? null;
    return source && !isMarkdownTokenSourceInsideIgnoredContent(source) ? source : null;
}

function findAdjacentSelectedMarkdownTokenSource(
    node: Node,
    offset: number,
    edge: "start" | "end",
): HTMLElement | null {
    const adjacent = readSelectedRangeAdjacentNode(node, offset, edge);
    return findContainingMarkdownTokenSource(adjacent);
}

function readSelectedRangeAdjacentNode(node: Node, offset: number, edge: "start" | "end"): Node | null {
    if (node.nodeType === Node.TEXT_NODE) {
        const textLength = node.textContent?.length ?? 0;
        if (edge === "start" && offset >= textLength) {
            return skipEmptyBoundaryText(node.nextSibling, "next");
        }

        if (edge === "end" && offset <= 0) {
            return skipEmptyBoundaryText(node.previousSibling, "previous");
        }

        return null;
    }

    if (!(node instanceof HTMLElement)) {
        return null;
    }

    const children = Array.from(node.childNodes);
    const adjacent = edge === "start" ? children[offset] : children[offset - 1];
    return skipEmptyBoundaryText(adjacent ?? null, edge === "start" ? "next" : "previous");
}

function skipEmptyBoundaryText(node: Node | null, direction: "next" | "previous"): Node | null {
    let current = node;
    while (current?.nodeType === Node.TEXT_NODE && current.textContent === "") {
        current = direction === "next" ? current.nextSibling : current.previousSibling;
    }

    return current;
}

function activateFormatMarkdownTokenSourceAtOffset(
    content: HTMLElement,
    token: HTMLElement,
    offset: number,
): boolean {
    if (!isEditableMarkdownToken(token)) {
        return false;
    }

    const tokenStart = getMarkdownBoundaryOffset(content, token, 0);
    const sourceOffset = offset - tokenStart;
    const sourceLength = readMarkdownTokenRawText(token).length;
    if (sourceOffset <= 0 || sourceOffset >= sourceLength) {
        return false;
    }

    const source = setActiveMarkdownToken(token);
    if (!source) {
        return false;
    }

    suppressSelectionChangeForFrame();
    focusMarkdownTokenSourceAtOffset(source, sourceOffset);
    return true;
}

function findClickedMarkdownToken(target: Element): HTMLElement | null {
    const directToken = target.closest<HTMLElement>(".markdown-token");
    const containingToken = directToken?.parentElement?.closest<HTMLElement>(".markdown-token");

    if (containingToken && isEditableMarkdownToken(containingToken)) {
        return containingToken;
    }

    return directToken && isEditableMarkdownToken(directToken) ? directToken : null;
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

function suppressSelectionChangeForFrame(): void {
    suppressSelectionChange = true;
    window.requestAnimationFrame(() => {
        suppressSelectionChange = false;
    });
}

function suppressCollapsedRevealForPointer(): void {
    suppressCollapsedPointerReveal = true;

    if (suppressCollapsedPointerRevealTimer) {
        window.clearTimeout(suppressCollapsedPointerRevealTimer);
    }

    suppressCollapsedPointerRevealTimer = window.setTimeout(clearCollapsedPointerRevealSuppression, 500);
}

function clearCollapsedPointerRevealSuppression(): void {
    suppressCollapsedPointerReveal = false;

    if (suppressCollapsedPointerRevealTimer) {
        window.clearTimeout(suppressCollapsedPointerRevealTimer);
        suppressCollapsedPointerRevealTimer = 0;
    }
}

function focusMarkdownTokenSource(
    source: HTMLElement,
    edge: "start" | "end" = "end",
    options: { advanceIntoSource?: boolean } = {},
): void {
    const sourceLength = source.textContent?.length ?? 0;
    const offset = readSourceFocusOffset(sourceLength, edge, options.advanceIntoSource ?? false);

    focusMarkdownTokenSourceAtOffset(source, offset);
}

function focusMarkdownTokenSourceAtOffset(source: HTMLElement, offset: number): void {
    const selection = document.getSelection();
    const range = document.createRange();

    if (!selection) {
        return;
    }

    getElement<HTMLElement>("editor").focus({ preventScroll: true });
    const position = getTextPosition(source, offset);
    range.setStart(position.node, position.offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
}

function focusMarkdownTokenSourceAtPoint(token: HTMLElement, clientX: number, clientY: number): boolean {
    const selection = document.getSelection();

    if (!selection) {
        return false;
    }

    const rect = token.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
        return false;
    }

    const position = getCaretPositionFromPoint(
        clamp(clientX, rect.left + 1, rect.right - 1),
        clamp(clientY, rect.top + 1, rect.bottom - 1),
    );

    if (!position || (position.node !== token && !token.contains(position.node))) {
        return false;
    }

    getElement<HTMLElement>("editor").focus({ preventScroll: true });
    const range = document.createRange();
    range.setStart(position.node, position.offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
}

function readSourceFocusOffset(sourceLength: number, edge: "start" | "end", advanceIntoSource: boolean): number {
    if (!advanceIntoSource) {
        return edge === "start" ? 0 : sourceLength;
    }

    return edge === "start" ? Math.min(sourceLength, 1) : Math.max(0, sourceLength - 1);
}

function readRenderedTokenClickEdge(token: HTMLElement, clientX: number): "start" | "end" | null {
    const rect = readRenderedTokenRect(token);
    if (!rect || rect.width <= 0) {
        return null;
    }

    const threshold = Math.max(4, Math.min(12, rect.width * 0.25));
    const edgeSlop = 1;
    if (clientX <= rect.left + threshold + edgeSlop) {
        return "start";
    }

    if (clientX >= rect.right - threshold - edgeSlop) {
        return "end";
    }

    return null;
}

function readRenderedTokenRect(token: HTMLElement): DOMRect | null {
    const renderedChild = Array.from(token.children).find(
        (child): child is HTMLElement =>
            child instanceof HTMLElement && child.dataset.sourceIgnore === "true",
    );
    const rect = (renderedChild ?? token).getBoundingClientRect();
    return rect.width > 0 || rect.height > 0 ? rect : null;
}

function getActiveMarkdownTokens(): HTMLElement[] {
    for (const token of Array.from(getElement<HTMLElement>("editor").querySelectorAll<HTMLElement>(".markdown-token[data-active='true']"))) {
        activeMarkdownTokens.add(token);
    }

    for (const token of Array.from(activeMarkdownTokens)) {
        if (!token.isConnected || token.dataset.active !== "true") {
            activeMarkdownTokens.delete(token);
        }
    }

    return Array.from(activeMarkdownTokens);
}

function syncSelectedMarkdownTokenSources(selection: Selection): void {
    const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (!range) {
        clearSelectedMarkdownTokenSources();
        return;
    }

    const root = getSelectionTokenSearchRoot(range);
    const nextTokens = new Set(
        Array.from(root.querySelectorAll<HTMLElement>(".markdown-token")).filter((token) => {
            if (!isEditableMarkdownToken(token)) {
                return false;
            }

            try {
                return range.intersectsNode(token);
            } catch {
                return false;
            }
        }),
    );

    for (const token of Array.from(selectedSourceMarkdownTokens)) {
        if (!nextTokens.has(token)) {
            delete token.dataset.selectedSource;
        }
    }

    for (const token of Array.from(nextTokens)) {
        token.dataset.selectedSource = "true";
    }

    selectedSourceMarkdownTokens = nextTokens;
}

function clearSelectedMarkdownTokenSources(): void {
    for (const token of Array.from(getElement<HTMLElement>("editor").querySelectorAll<HTMLElement>(".markdown-token[data-selected-source='true']"))) {
        selectedSourceMarkdownTokens.add(token);
    }

    for (const token of Array.from(selectedSourceMarkdownTokens)) {
        delete token.dataset.selectedSource;
    }

    selectedSourceMarkdownTokens.clear();
}

function getSelectionTokenSearchRoot(range: Range): HTMLElement {
    const container = range.commonAncestorContainer;
    const element = container instanceof HTMLElement ? container : container.parentElement;
    const block = findBlock(element ?? null);
    return block ? getBlockContent(block) : getElement<HTMLElement>("editor");
}
