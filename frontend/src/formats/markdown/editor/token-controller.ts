import { Browser } from "@wailsio/runtime";
import {
    findMarkdownTokenAtCaret,
    getMarkdownBoundaryOffset,
    getMarkdownText,
} from "../dom";
import {
    getTokenBoundaryPositionSkippingSpacer,
    isCompleteInlineTokenSource,
    readMarkdownTokenSourceFocusOffset,
} from "./token-navigation";
import {
    findBlock,
    getBlockContent,
    getBlockText,
    getSiblingBlock,
    setBlockText,
} from "../../../editor/blocks/view";
import {
    focusBlockAtOffset,
    getCaretOffset,
    getCaretPositionFromPoint,
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
        if (target.closest(".markdown-token-source")) {
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
    if (!(target instanceof Element) || target.closest(".markdown-token-source")) {
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

export function getFocusedMarkdownTokenSource(): HTMLElement | null {
    const focusNode = document.getSelection()?.focusNode;
    const focusElement = focusNode instanceof Element ? focusNode : focusNode?.parentElement;
    const source = focusElement?.closest<HTMLElement>(".markdown-token-source") ?? null;

    return source && !isMarkdownTokenSourceInsideIgnoredContent(source) ? source : null;
}

function setActiveMarkdownToken(token: HTMLElement): void {
    const activeTokens = getActiveMarkdownTokens();

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
    activeMarkdownTokens.add(token);
}

function activateMarkdownTokenSource(
    token: HTMLElement,
    edge: "start" | "end" = "end",
    options: { advanceIntoSource?: boolean } = {},
): void {
    setActiveMarkdownToken(token);
    suppressSelectionChangeForFrame();
    focusMarkdownTokenSource(token, edge, options);
}

function activateMarkdownTokenSourceAtPoint(
    token: HTMLElement,
    clientX: number,
    clientY: number,
    fallbackEdge: "start" | "end" = "end",
): void {
    const renderedEdge = token.dataset.active === "true" ? null : readRenderedTokenClickEdge(token, clientX);

    setActiveMarkdownToken(token);
    suppressSelectionChangeForFrame();

    if (renderedEdge) {
        focusMarkdownTokenSource(token, renderedEdge);
        return;
    }

    if (focusMarkdownTokenSourceAtPoint(token, clientX, clientY)) {
        return;
    }

    focusMarkdownTokenSource(token, fallbackEdge);
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

    setActiveMarkdownToken(tokenPosition.token);
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

    return token?.dataset.active === "true" && isEditableMarkdownToken(token) ? token : null;
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
        focusTokenBoundaryEdge?: "start" | "end";
        advanceAcrossAdjacentText?: boolean;
        suppressTokenActivationAtFocus?: boolean;
    } = {},
): void {
    const activeTokens = getActiveMarkdownTokens();

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
        if (update.hasSourceEdits) {
            setBlockText(update.block, update.text);
            continue;
        }

        for (const token of update.tokens) {
            deactivateMarkdownToken(token);
        }
    }

    if (selectionBlock?.isConnected && selectionOffset !== null) {
        const focusOffset = Math.min(selectionOffset, getBlockText(selectionBlock).length);
        const hasFormatTokenInFocusBlock = updates.some((update) => update.block === selectionBlock && update.hasFormatToken);

        if (options.suppressTokenActivationAtFocus || hasFormatTokenInFocusBlock) {
            suppressedMarkdownTokenActivation = { block: selectionBlock, offset: focusOffset };
        }

        suppressSelectionChangeForFrame();
        if (
            options.focusTokenBoundaryEdge &&
            focusMarkdownTokenBoundaryAtOffset(selectionBlock, focusOffset, {
                edge: options.focusTokenBoundaryEdge,
                advanceAcrossAdjacentText: options.advanceAcrossAdjacentText ?? false,
            })
        ) {
            return;
        }

        focusBlockAtOffset(selectionBlock, focusOffset);
    }
}

function isEditableMarkdownToken(token: HTMLElement): boolean {
    return getMarkdownTokenSource(token) !== null;
}

function isAutoActivatableMarkdownToken(token: HTMLElement): boolean {
    return isEditableMarkdownToken(token) && !isFormatMarkdownToken(token);
}

function getMarkdownTokenForSource(source: HTMLElement): HTMLElement | null {
    const parent = source.parentElement;
    return parent instanceof HTMLElement && parent.classList.contains("markdown-token") ? parent : null;
}

function isMarkdownTokenSourceInsideIgnoredContent(source: HTMLElement): boolean {
    return Boolean(source.parentElement?.closest("[data-source-ignore='true']"));
}

export function moveCaretOutOfActiveMarkdownTokenSource(event: KeyboardEvent, block: HTMLElement): boolean {
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
    const source = getFocusedMarkdownTokenSource();
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
    clearActiveMarkdownToken({
        focusBlock: block,
        focusOffset: blockOffset,
        focusTokenBoundaryEdge: isLeavingStart ? "start" : "end",
        advanceAcrossAdjacentText: true,
        suppressTokenActivationAtFocus: true,
    });
    return true;
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
        focusTokenBoundaryEdge: "end",
        suppressTokenActivationAtFocus: true,
    });
    return true;
}

export function normalizeActiveMarkdownTokenSource(block: HTMLElement): void {
    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    const source = getFocusedMarkdownTokenSource();

    if (!selection?.isCollapsed || !focusNode || !source) {
        return;
    }

    const sourceText = getMarkdownText(source);
    if (!isCompleteInlineTokenSource(sourceText)) {
        return;
    }

    const sourceOffset = getCaretOffset(source, focusNode, selection.focusOffset);
    const blockOffset = getCaretOffset(getBlockContent(block), focusNode, selection.focusOffset);
    const markdown = getBlockText(block);

    setBlockText(block, markdown);
    restoreInlineSourceFocusAfterRender(block, blockOffset, sourceOffset);
}

export function moveCaretOutOfInactiveMarkdownTokenSourceBoundary(block: HTMLElement, blockOffset: number): boolean {
    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    const source = getFocusedMarkdownTokenSource();
    const token = source ? getMarkdownTokenForSource(source) : null;

    if (!selection?.isCollapsed || !focusNode || !source || !token || token.dataset.active === "true") {
        return false;
    }

    const sourceOffset = getCaretOffset(source, focusNode, selection.focusOffset);
    const sourceLength = getMarkdownText(source).length;
    const edge = sourceOffset === 0 ? "start" : sourceOffset === sourceLength ? "end" : null;

    if (!edge) {
        return false;
    }

    suppressedMarkdownTokenActivation = { block, offset: blockOffset };
    suppressSelectionChangeForFrame();
    return focusMarkdownTokenBoundaryAtOffset(block, blockOffset, {
        edge,
        advanceAcrossAdjacentText: false,
    });
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

function activateFormatMarkdownTokenSourceAtOffset(
    content: HTMLElement,
    token: HTMLElement,
    offset: number,
): boolean {
    const source = getMarkdownTokenSource(token);
    if (!source) {
        return false;
    }

    const tokenStart = getMarkdownBoundaryOffset(content, token, 0);
    const sourceOffset = offset - tokenStart;
    const sourceLength = getMarkdownText(source).length;
    if (sourceOffset <= 0 || sourceOffset >= sourceLength) {
        return false;
    }

    setActiveMarkdownToken(token);
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
    token: HTMLElement,
    edge: "start" | "end" = "end",
    options: { advanceIntoSource?: boolean } = {},
): void {
    const source = getMarkdownTokenSource(token);
    const selection = document.getSelection();
    const range = document.createRange();

    if (!source || !selection) {
        return;
    }

    getElement<HTMLElement>("editor").focus();
    const sourceLength = source.textContent?.length ?? 0;
    const offset = readMarkdownTokenSourceFocusOffset(sourceLength, edge, options.advanceIntoSource ?? false);
    const position = getTextPosition(source, offset);

    range.setStart(position.node, position.offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
}

function focusMarkdownTokenSourceAtOffset(source: HTMLElement, offset: number): void {
    const selection = document.getSelection();
    const range = document.createRange();

    if (!selection) {
        return;
    }

    getElement<HTMLElement>("editor").focus();
    const position = getTextPosition(source, offset);
    range.setStart(position.node, position.offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
}

function focusMarkdownTokenSourceAtPoint(token: HTMLElement, clientX: number, clientY: number): boolean {
    const source = getMarkdownTokenSource(token);
    const selection = document.getSelection();

    if (!source || !selection) {
        return false;
    }

    const rect = source.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
        return false;
    }

    const position = getCaretPositionFromPoint(
        clamp(clientX, rect.left + 1, rect.right - 1),
        clamp(clientY, rect.top + 1, rect.bottom - 1),
    );

    if (!position || (position.node !== source && !source.contains(position.node))) {
        return false;
    }

    getElement<HTMLElement>("editor").focus();
    const range = document.createRange();
    range.setStart(position.node, position.offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
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

function focusMarkdownTokenBoundaryAtOffset(
    block: HTMLElement,
    offset: number,
    options: { edge: "start" | "end"; advanceAcrossAdjacentText: boolean },
): boolean {
    const content = getBlockContent(block);
    const tokens = Array.from(content.querySelectorAll<HTMLElement>(".markdown-token"));
    const token = tokens.find((candidate) => {
        const tokenOffset = getMarkdownBoundaryOffset(
            content,
            candidate,
            options.edge === "start" ? 0 : candidate.childNodes.length,
        );

        return tokenOffset === offset;
    });

    if (!token?.parentNode) {
        return false;
    }

    const editor = getElement<HTMLElement>("editor");
    const selection = document.getSelection();
    const range = document.createRange();
    const childIndex = Array.from(token.parentNode.childNodes).findIndex((child) => child === token);

    if (!selection || childIndex < 0) {
        return false;
    }

    const boundary = getTokenBoundaryPositionSkippingSpacer(token, childIndex, options);

    editor.focus();
    range.setStart(boundary.node, boundary.offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
}

function hasActiveMarkdownTokenSourceEdits(token: HTMLElement): boolean {
    return (
        token.dataset.sourceBeforeActivation !== undefined &&
        getMarkdownText(token) !== token.dataset.sourceBeforeActivation
    );
}

function restoreInlineSourceFocusAfterRender(block: HTMLElement, blockOffset: number, sourceOffset: number): void {
    const content = getBlockContent(block);
    const focusOffset = Math.min(blockOffset, getBlockText(block).length);
    const tokenPosition = findMarkdownTokenAtBlockOffset(content, focusOffset, isEditableMarkdownToken);
    const token = tokenPosition?.token;
    const source = token ? getMarkdownTokenSource(token) : null;

    if (!token || !source) {
        focusBlockAtOffset(block, focusOffset);
        return;
    }

    setActiveMarkdownToken(token);
    suppressSelectionChangeForFrame();
    focusMarkdownTokenSourceAtOffset(source, Math.min(sourceOffset, source.textContent?.length ?? 0));
}

function getMarkdownTokenSource(token: HTMLElement): HTMLElement | null {
    return (
        Array.from(token.children).find(
            (child): child is HTMLElement =>
                child instanceof HTMLElement && child.classList.contains("markdown-token-source"),
        ) ?? null
    );
}

function isFormatMarkdownToken(token: HTMLElement): boolean {
    return token.classList.contains("markdown-format-token");
}

function deactivateMarkdownToken(token: HTMLElement): void {
    delete token.dataset.active;
    delete token.dataset.sourceBeforeActivation;
    activeMarkdownTokens.delete(token);
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
