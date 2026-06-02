import { Browser } from "@wailsio/runtime";
import {
    findAdjacentInactiveMarkdownToken,
    findMarkdownTokenAtCaret,
    getMarkdownBoundaryOffset,
    getMarkdownText,
} from "../dom";
import { findVerticalMarkdownImageToken } from "./block-operations";
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
    getCurrentBlockOffset,
    getTextPosition,
} from "../../../editor/selection/caret";
import { stripCaretSpacers } from "../../../editor/selection/rendered-content-dom";
import { getElement } from "../../../utils/dom";
import { clamp } from "../../../utils/text";
import { setPointerSelecting } from "../../../editor/pointer-interactions";

type MarkdownTokenMatcher = (token: HTMLElement) => boolean;

type MarkdownTokenHooks = {
    syncActiveBlockIndicator?: (block: HTMLElement | null) => void;
    syncActiveBlockMarkdownSource?: (focusBlock: HTMLElement | null) => void;
    syncBlockMarkdownSourceReveal?: (block: HTMLElement | null) => void;
};

let hooks: MarkdownTokenHooks = {};
let suppressSelectionChange = false;
let suppressedMarkdownTokenActivation: { block: HTMLElement; offset: number } | null = null;
let suppressNextCollapsedTokenActivation = false;
let suppressNextCollapsedTokenActivationTimer = 0;
let pendingMouseDownTokenActivation: { token: HTMLElement; requestId: number } | null = null;
let pendingMouseDownTokenActivationRequestId = 0;
let pendingMouseDownTokenActivationTimer = 0;
let pendingClickRevealRequestId = 0;
let pendingVerticalLeadingTokenNavigationRequestId = 0;
let pendingVerticalLeadingTokenNavigationTarget: { requestId: number } | null = null;
let activeMarkdownTokens = new Set<HTMLElement>();
let selectedSourceMarkdownTokens = new Set<HTMLElement>();

export function configureMarkdownTokenController(nextHooks: MarkdownTokenHooks): void {
    hooks = { ...hooks, ...nextHooks };
}

export function handleEditorClick(event: MouseEvent): void {
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
        const consumedMouseDownActivation = consumePendingMouseDownTokenActivation(token);

        if (target.closest(".markdown-token-source")) {
            setActiveMarkdownToken(token);
            if (consumedMouseDownActivation) {
                event.preventDefault();
                event.stopPropagation();
            }
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

        if (consumedMouseDownActivation) {
            return;
        }

        activateMarkdownTokenSourceAtPoint(token, event.clientX, event.clientY);
        return;
    }

    const link = target.closest("a.markdown-link") as HTMLAnchorElement | null;
    const href = link?.dataset.href;
    if (!href) {
        const pendingToken = pendingMouseDownTokenActivation?.token;
        if (pendingToken?.isConnected) {
            clearPendingMouseDownTokenActivation();
            return;
        }

        scheduleClickCaretTokenReveal(event.clientX, event.clientY, target);
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

    const token = findClickedMarkdownToken(target);
    if (token) {
        event.preventDefault();
        event.stopPropagation();
        activateMarkdownTokenSourceAtPoint(token, event.clientX, event.clientY);
        trackPendingMouseDownTokenActivation(token);
        return true;
    }

    if (!activateMarkdownTokenAtPoint(event.clientX, event.clientY, target, isEditableMarkdownToken)) {
        return false;
    }

    const activeToken = getActiveMarkdownTokens()[0];
    if (activeToken) {
        trackPendingMouseDownTokenActivation(activeToken);
    }

    event.preventDefault();
    event.stopPropagation();
    return true;
}

function scheduleClickCaretTokenReveal(clientX: number, clientY: number, target: Element): void {
    const requestId = pendingClickRevealRequestId + 1;
    pendingClickRevealRequestId = requestId;

    window.requestAnimationFrame(() => {
        if (requestId !== pendingClickRevealRequestId) {
            return;
        }

        if (activateMarkdownTokenAtPoint(clientX, clientY, target, isEditableMarkdownToken)) {
            return;
        }

        clearActiveMarkdownToken();
    });
}

export function handleSelectionChange(): void {
    if (suppressSelectionChange) {
        return;
    }

    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    const focusBlock = findBlock(focusNode ?? null);
    hooks.syncActiveBlockIndicator?.(focusBlock);
    hooks.syncActiveBlockMarkdownSource?.(focusBlock);

    if (selection && !selection.isCollapsed) {
        hooks.syncBlockMarkdownSourceReveal?.(focusBlock);
        clearPendingMarkdownTokenNavigation();
        syncSelectedMarkdownTokenSources(selection);
        setPointerSelecting(true);
        return;
    }

    clearSelectedMarkdownTokenSources();
    hooks.syncBlockMarkdownSourceReveal?.(focusBlock);

    if (selection?.isCollapsed && normalizeInactiveRenderedMarkdownTokenSelection(selection)) {
        return;
    }

    const source = getFocusedMarkdownTokenSource();
    const sourceToken = source ? getMarkdownTokenForSource(source) : null;

    if (sourceToken) {
        if (selection && sourceToken.dataset.active !== "true" && shouldSuppressMarkdownTokenActivation(selection)) {
            return;
        }

        setActiveMarkdownToken(sourceToken);
        return;
    }

    if (selection?.isCollapsed && revealPendingVerticalLeadingTokenNavigationTarget()) {
        return;
    }

    if (selection?.isCollapsed && shouldSuppressMarkdownTokenActivation(selection)) {
        return;
    }

    if (selection?.isCollapsed && activateEditableMarkdownTokenAtRenderedEndBoundary(selection)) {
        return;
    }

    if (selection?.isCollapsed && consumeSuppressedCollapsedTokenActivation()) {
        clearActiveMarkdownToken();
        return;
    }

    if (activateMarkdownTokenAtCaret()) {
        return;
    }

    clearActiveMarkdownToken();
}

export function clearPendingMarkdownTokenNavigation(): void {
    pendingVerticalLeadingTokenNavigationTarget = null;
    clearPendingMouseDownTokenActivation();
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

function activateMarkdownTokenAtPoint(
    clientX: number,
    clientY: number,
    target: Element,
    isTokenMatch: MarkdownTokenMatcher = isAutoActivatableMarkdownToken,
): boolean {
    const position = getCaretPositionFromPoint(clientX, clientY);
    if (position && activateMarkdownTokenAtPointPosition(position.node, position.offset, clientX, clientY, isTokenMatch)) {
        return true;
    }

    const block = findPointBlock(target, clientX, clientY);
    return block ? activateMarkdownTokenAtBlockPoint(block, clientX, clientY, isTokenMatch) : false;
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

function activateMarkdownTokenAtPointPosition(
    node: Node,
    offset: number,
    clientX: number,
    clientY: number,
    isTokenMatch: MarkdownTokenMatcher,
): boolean {
    const activeToken = findActiveMarkdownTokenAtPosition(node);
    if (activeToken) {
        focusMarkdownTokenSourceAtPoint(activeToken, clientX, clientY);
        return true;
    }

    const tokenPosition = findMarkdownTokenAtCaret(node, offset, isTokenMatch);
    if (!tokenPosition) {
        return false;
    }

    activateMarkdownTokenSourceAtPoint(tokenPosition.token, clientX, clientY, tokenPosition.edge);
    return true;
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

function activateMarkdownTokenAtBlockPoint(
    block: HTMLElement,
    clientX: number,
    clientY: number,
    isTokenMatch: MarkdownTokenMatcher,
): boolean {
    const content = getBlockContent(block);
    const rect = content.getBoundingClientRect();

    if (clientY < rect.top || clientY > rect.bottom) {
        return false;
    }

    const clampedX = clamp(clientX, rect.left + 1, rect.right - 1);
    const clampedY = clamp(clientY, rect.top + 1, rect.bottom - 1);
    const position = getCaretPositionFromPoint(clampedX, clampedY);
    if (position && (position.node === content || content.contains(position.node))) {
        const offset = getCaretOffset(content, position.node, position.offset);
        return activateMarkdownTokenAtBlockOffset(content, offset, isTokenMatch);
    }

    if (clientX <= rect.left) {
        return activateMarkdownTokenAtBlockOffset(content, 0, isTokenMatch);
    }

    return activateMarkdownTokenAtBlockOffset(content, getBlockText(block).length, isTokenMatch);
}

function activateMarkdownTokenAtBlockOffset(
    content: HTMLElement,
    offset: number,
    isTokenMatch: MarkdownTokenMatcher,
): boolean {
    const position = getTextPosition(content, offset);
    return activateMarkdownTokenAtPosition(position.node, position.offset, isTokenMatch);
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

export function trackHorizontalMarkdownNavigation(event: KeyboardEvent): void {
    if (
        (event.key !== "ArrowLeft" && event.key !== "ArrowRight") ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
    ) {
        return;
    }

    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    if (!selection?.isCollapsed || !focusNode) {
        return;
    }

    const direction = event.key === "ArrowLeft" ? "previous" : "next";
    const containingToken = findInactiveEditableMarkdownTokenAtSelection(focusNode);
    if (containingToken) {
        event.preventDefault();
        activateMarkdownTokenSource(containingToken, direction === "previous" ? "end" : "start", { advanceIntoSource: true });
        return;
    }

    const token = findAdjacentInactiveMarkdownToken(focusNode, selection.focusOffset, direction);
    if (!token || !isEditableMarkdownToken(token)) {
        return;
    }

    event.preventDefault();
    activateMarkdownTokenSource(token, direction === "previous" ? "end" : "start", { advanceIntoSource: true });
}

export function moveCaretOutOfInactiveMarkdownTokenVerticalNavigation(event: KeyboardEvent): boolean {
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

    const token = findInactiveEditableMarkdownTokenAtSelection(focusNode);
    if (!token) {
        return false;
    }

    event.preventDefault();
    suppressCollapsedTokenActivationForVerticalMove();
    moveCaretFromInactiveMarkdownToken(token, readInactiveMarkdownTokenSelectionEdge(token, focusNode, selection.focusOffset), event.key);
    return true;
}

export function trackVerticalLeadingTokenNavigation(event: KeyboardEvent, block: HTMLElement): void {
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
    if (!selection?.isCollapsed) {
        pendingVerticalLeadingTokenNavigationTarget = null;
        return;
    }

    suppressCollapsedTokenActivationForVerticalMove();

    if (getCurrentBlockOffset(block) !== 0) {
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

export function trackVerticalMarkdownImageNavigation(event: KeyboardEvent, block: HTMLElement): boolean {
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
    clearPendingMarkdownTokenNavigation();
    activateMarkdownTokenSource(targetToken, direction === "previous" ? "end" : "start");
    return true;
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

    const text = getMarkdownText(source);
    if (isCompleteInlineTokenSource(text)) {
        return;
    }

    const offset = getCurrentBlockOffset(block);
    const markdown = getBlockText(block);

    setBlockText(block, markdown);
    focusBlockAtOffset(block, Math.min(offset, getBlockText(block).length));
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
        clearSuppressedCollapsedTokenActivation();
        activateMarkdownTokenSource(previousToken, "start");
        return true;
    }

    const nextToken = findAdjacentInactiveMarkdownToken(focusNode, selection.focusOffset, "next");
    if (nextToken && isEditableMarkdownToken(nextToken) && isLeadingTokenInBlock(nextToken)) {
        clearSuppressedCollapsedTokenActivation();
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

function findInactiveEditableMarkdownTokenAtSelection(node: Node): HTMLElement | null {
    const element = node instanceof Element ? node : node.parentElement;
    const token = element?.closest<HTMLElement>(".markdown-token");
    if (!token) {
        return null;
    }

    const containingToken = token.parentElement?.closest<HTMLElement>(".markdown-token");
    const candidate =
        containingToken && token.closest("[data-source-ignore='true']")
            ? containingToken
            : token;

    return candidate.dataset.active !== "true" && isEditableMarkdownToken(candidate) ? candidate : null;
}

function normalizeInactiveRenderedMarkdownTokenSelection(selection: Selection): boolean {
    const focusNode = selection.focusNode;
    const focusElement = focusNode instanceof Element ? focusNode : focusNode?.parentElement;
    if (!focusNode || !focusElement?.closest("[data-source-ignore='true']")) {
        return false;
    }

    const token = findInactiveEditableMarkdownTokenAtSelection(focusNode);
    if (!token) {
        return false;
    }

    const edge = readInactiveMarkdownTokenSelectionEdge(token, focusNode, selection.focusOffset);
    if (edge === "end" && isRenderedTokenEdgeSelection(token, focusNode, selection.focusOffset, edge)) {
        activateMarkdownTokenSource(token, edge);
        return true;
    }

    suppressSelectionChangeForFrame();
    focusMarkdownTokenBoundary(token, edge);
    return true;
}

function readInactiveMarkdownTokenSelectionEdge(
    token: HTMLElement,
    focusNode: Node,
    focusOffset: number,
): "start" | "end" {
    const source = getMarkdownTokenSource(token);
    if (source && (focusNode === source || source.contains(focusNode))) {
        const sourceOffset = getCaretOffset(source, focusNode, focusOffset);
        return sourceOffset <= 0 ? "start" : "end";
    }

    if (focusNode.nodeType === Node.TEXT_NODE) {
        return focusOffset <= 0 ? "start" : "end";
    }

    return focusOffset <= 0 ? "start" : "end";
}

function isRenderedTokenEdgeSelection(
    token: HTMLElement,
    focusNode: Node,
    focusOffset: number,
    edge: "start" | "end",
): boolean {
    const rendered = getMarkdownTokenRenderedContent(token);
    if (!rendered || (focusNode !== rendered && !rendered.contains(focusNode))) {
        return false;
    }

    const renderedOffset = getRenderedTokenContentOffset(rendered, focusNode, focusOffset);
    const renderedLength = getRenderedTokenContentLength(rendered);
    return edge === "start" ? renderedOffset <= 0 : renderedOffset >= renderedLength;
}

function getMarkdownTokenRenderedContent(token: HTMLElement): HTMLElement | null {
    return (
        Array.from(token.children).find(
            (child): child is HTMLElement =>
                child instanceof HTMLElement && child.dataset.sourceIgnore === "true",
        ) ?? null
    );
}

function getRenderedTokenContentOffset(root: Node, focusNode: Node, focusOffset: number): number {
    if (root === focusNode) {
        if (root.nodeType === Node.TEXT_NODE) {
            return stripCaretSpacers((root.textContent ?? "").slice(0, focusOffset)).length;
        }

        return getRenderedTokenContentLengthBeforeChild(root, focusOffset);
    }

    let offset = 0;
    for (const child of Array.from(root.childNodes)) {
        if (child === focusNode || child.contains(focusNode)) {
            return offset + getRenderedTokenContentOffset(child, focusNode, focusOffset);
        }

        offset += getRenderedTokenContentLength(child);
    }

    return offset;
}

function getRenderedTokenContentLengthBeforeChild(node: Node, childOffset: number): number {
    return Array.from(node.childNodes)
        .slice(0, Math.max(0, childOffset))
        .reduce((length, child) => length + getRenderedTokenContentLength(child), 0);
}

function getRenderedTokenContentLength(node: Node): number {
    if (node instanceof HTMLElement && node.classList.contains("markdown-token-source")) {
        return 0;
    }

    if (node.nodeType === Node.TEXT_NODE) {
        return stripCaretSpacers(node.textContent ?? "").length;
    }

    return Array.from(node.childNodes).reduce((length, child) => length + getRenderedTokenContentLength(child), 0);
}

function activateEditableMarkdownTokenAtRenderedEndBoundary(selection: Selection): boolean {
    const focusNode = selection.focusNode;
    if (!focusNode) {
        return false;
    }

    const token = findAdjacentInactiveMarkdownToken(focusNode, selection.focusOffset, "previous");
    if (!token || !isEditableMarkdownToken(token)) {
        return false;
    }

    clearSuppressedCollapsedTokenActivation();
    activateMarkdownTokenSource(token, "end");
    return true;
}

function moveCaretFromInactiveMarkdownToken(token: HTMLElement, edge: "start" | "end", key: "ArrowUp" | "ArrowDown"): void {
    const block = findBlock(token);
    if (!block) {
        focusMarkdownTokenBoundary(token, edge);
        return;
    }

    const content = getBlockContent(block);
    const sourceOffset = getMarkdownBoundaryOffset(content, token, edge === "start" ? 0 : token.childNodes.length);
    const sibling = getSiblingBlock(block, key === "ArrowUp" ? "previous" : "next");
    if (!sibling) {
        focusMarkdownTokenBoundary(token, edge);
        return;
    }

    focusBlockAtOffset(sibling, Math.min(sourceOffset, getBlockText(sibling).length), { scroll: "minimal" });
}

function trackPendingMouseDownTokenActivation(token: HTMLElement): void {
    const requestId = pendingMouseDownTokenActivationRequestId + 1;
    pendingMouseDownTokenActivationRequestId = requestId;
    pendingMouseDownTokenActivation = { token, requestId };

    if (pendingMouseDownTokenActivationTimer) {
        window.clearTimeout(pendingMouseDownTokenActivationTimer);
    }

    pendingMouseDownTokenActivationTimer = window.setTimeout(() => {
        if (pendingMouseDownTokenActivation?.requestId === requestId) {
            clearPendingMouseDownTokenActivation();
        }
    }, 500);
}

function consumePendingMouseDownTokenActivation(token: HTMLElement): boolean {
    if (pendingMouseDownTokenActivation?.token !== token) {
        return false;
    }

    clearPendingMouseDownTokenActivation();
    return true;
}

function clearPendingMouseDownTokenActivation(): void {
    pendingMouseDownTokenActivation = null;

    if (pendingMouseDownTokenActivationTimer) {
        window.clearTimeout(pendingMouseDownTokenActivationTimer);
        pendingMouseDownTokenActivationTimer = 0;
    }
}

function suppressCollapsedTokenActivationForVerticalMove(): void {
    suppressNextCollapsedTokenActivation = true;

    if (suppressNextCollapsedTokenActivationTimer) {
        window.clearTimeout(suppressNextCollapsedTokenActivationTimer);
    }

    suppressNextCollapsedTokenActivationTimer = window.setTimeout(() => {
        suppressNextCollapsedTokenActivation = false;
        suppressNextCollapsedTokenActivationTimer = 0;
    }, 300);
}

function consumeSuppressedCollapsedTokenActivation(): boolean {
    if (!suppressNextCollapsedTokenActivation) {
        return false;
    }

    clearSuppressedCollapsedTokenActivation();
    return true;
}

function clearSuppressedCollapsedTokenActivation(): void {
    suppressNextCollapsedTokenActivation = false;

    if (suppressNextCollapsedTokenActivationTimer) {
        window.clearTimeout(suppressNextCollapsedTokenActivationTimer);
        suppressNextCollapsedTokenActivationTimer = 0;
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

function focusMarkdownTokenBoundary(token: HTMLElement, edge: "start" | "end"): boolean {
    const editor = getElement<HTMLElement>("editor");
    const parent = token.parentNode;
    const selection = document.getSelection();
    const range = document.createRange();
    const childIndex = parent ? Array.from(parent.childNodes).findIndex((child) => child === token) : -1;

    if (!parent || !selection || childIndex < 0) {
        return false;
    }

    const boundary = getTokenBoundaryPositionSkippingSpacer(token, childIndex, {
        edge,
        advanceAcrossAdjacentText: false,
    });

    editor.focus();
    range.setStart(boundary.node, boundary.offset);
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
