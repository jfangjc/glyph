import { Browser } from "@wailsio/runtime";
import {
    findAdjacentInactiveMarkdownToken,
    findMarkdownTokenAtCaret,
    getMarkdownBoundaryOffset,
    getMarkdownText,
    type MarkdownTokenEdge,
} from "../dom";
import { findFirstInlineToken } from "../inline";
import { findVerticalMarkdownImageToken } from "./block-operations";
import {
    findBlock,
    getBlockContent,
    getBlockText,
    setBlockText,
} from "../../../editor/blocks/view";
import {
    focusBlockAtOffset,
    getCaretOffset,
    getCaretPositionFromPoint,
    getCurrentBlockOffset,
    getTextPosition,
} from "../../../editor/selection/caret";
import { caretSpacerCharacter } from "../../../editor/selection/rendered-content-dom";
import { getElement } from "../../../utils/dom";
import { clamp } from "../../../utils/text";
import { setPointerSelecting } from "../../../editor/pointer-interactions";

type MarkdownTokenHooks = {
    syncActiveBlockIndicator?: (block: HTMLElement | null) => void;
    syncActiveBlockMarkdownSource?: (focusBlock: HTMLElement | null) => void;
    syncBlockMarkdownSourceReveal?: (block: HTMLElement | null) => void;
};

let hooks: MarkdownTokenHooks = {};
let suppressSelectionChange = false;
let suppressedMarkdownTokenActivation: { block: HTMLElement; offset: number } | null = null;
let pendingHorizontalNavigationTarget: { token: HTMLElement; edge: MarkdownTokenEdge; requestId: number } | null = null;
let pendingHorizontalNavigationRequestId = 0;
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

        activateMarkdownTokenSourceAtPoint(token, event.clientX, event.clientY);
        return;
    }

    const link = target.closest("a.markdown-link") as HTMLAnchorElement | null;
    const href = link?.dataset.href;
    if (!href) {
        scheduleClickCaretTokenReveal(event.clientX, event.clientY, target);
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    clearActiveMarkdownToken();

    if (event.ctrlKey || event.metaKey) {
        void Browser.OpenURL(href).catch((error) => console.error("Failed to open URL:", error));
    }
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
        return true;
    }

    if (!activateMarkdownTokenAtPoint(event.clientX, event.clientY, target)) {
        return false;
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

        if (activateMarkdownTokenAtPoint(clientX, clientY, target)) {
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

    const source = getFocusedMarkdownTokenSource();
    const sourceToken = source ? getMarkdownTokenForSource(source) : null;

    if (sourceToken) {
        if (selection && sourceToken.dataset.active !== "true" && shouldSuppressMarkdownTokenActivation(selection)) {
            return;
        }

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

export function clearPendingMarkdownTokenNavigation(): void {
    pendingHorizontalNavigationTarget = null;
    pendingVerticalLeadingTokenNavigationTarget = null;
}

export function getFocusedMarkdownTokenSource(): HTMLElement | null {
    const focusNode = document.getSelection()?.focusNode;
    const focusElement = focusNode instanceof Element ? focusNode : focusNode?.parentElement;

    return focusElement?.closest<HTMLElement>(".markdown-token-source") ?? null;
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
    setActiveMarkdownToken(token);
    suppressSelectionChangeForFrame();

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

function activateMarkdownTokenAtPoint(clientX: number, clientY: number, target: Element): boolean {
    const position = getCaretPositionFromPoint(clientX, clientY);
    if (position && activateMarkdownTokenAtPointPosition(position.node, position.offset, clientX, clientY)) {
        return true;
    }

    const block = findPointBlock(target, clientX, clientY);
    return block ? activateMarkdownTokenAtBlockPoint(block, clientX, clientY) : false;
}

function activateMarkdownTokenAtPosition(node: Node, offset: number): boolean {
    if (isPositionInActiveMarkdownToken(node)) {
        return true;
    }

    const tokenPosition = findMarkdownTokenAtCaret(node, offset, isAutoActivatableMarkdownToken);
    if (!tokenPosition) {
        return false;
    }

    activateMarkdownTokenSource(tokenPosition.token, tokenPosition.edge);
    return true;
}

function activateMarkdownTokenAtPointPosition(node: Node, offset: number, clientX: number, clientY: number): boolean {
    const activeToken = findActiveMarkdownTokenAtPosition(node);
    if (activeToken) {
        focusMarkdownTokenSourceAtPoint(activeToken, clientX, clientY);
        return true;
    }

    const tokenPosition = findMarkdownTokenAtCaret(node, offset, isAutoActivatableMarkdownToken);
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

function activateMarkdownTokenAtBlockPoint(block: HTMLElement, clientX: number, clientY: number): boolean {
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
        return activateMarkdownTokenAtBlockOffset(content, offset);
    }

    if (clientX <= rect.left) {
        return activateMarkdownTokenAtBlockOffset(content, 0);
    }

    return activateMarkdownTokenAtBlockOffset(content, getBlockText(block).length);
}

function activateMarkdownTokenAtBlockOffset(content: HTMLElement, offset: number): boolean {
    const position = getTextPosition(content, offset);
    return activateMarkdownTokenAtPosition(position.node, position.offset);
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

        if (options.suppressTokenActivationAtFocus || updates.some((update) => update.hasFormatToken)) {
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

export function trackHorizontalMarkdownNavigation(event: KeyboardEvent): void {
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
    pendingHorizontalNavigationTarget = null;
    clearActiveMarkdownToken({
        focusBlock: block,
        focusOffset: blockOffset,
        focusTokenBoundaryEdge: isLeavingStart ? "start" : "end",
        advanceAcrossAdjacentText: true,
        suppressTokenActivationAtFocus: true,
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
    pendingHorizontalNavigationTarget = null;
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

function isCompleteInlineTokenSource(text: string): boolean {
    const tokenMatch = findFirstInlineToken(text);
    return Boolean(tokenMatch && tokenMatch.start === 0 && tokenMatch.token.raw.length === text.length);
}

function revealPendingHorizontalNavigationTarget(): boolean {
    const target = pendingHorizontalNavigationTarget;
    pendingHorizontalNavigationTarget = null;

    if (!target?.token.isConnected || target.token.dataset.active === "true") {
        return false;
    }

    activateMarkdownTokenSource(target.token, target.edge, { advanceIntoSource: true });
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

    const range = document.createRange();
    range.setStart(position.node, position.offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
}

function readMarkdownTokenSourceFocusOffset(
    sourceLength: number,
    edge: "start" | "end",
    advanceIntoSource: boolean,
): number {
    if (!advanceIntoSource) {
        return edge === "start" ? 0 : sourceLength;
    }

    return edge === "start" ? Math.min(sourceLength, 1) : Math.max(0, sourceLength - 1);
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

function getTokenBoundaryPositionSkippingSpacer(
    token: HTMLElement,
    childIndex: number,
    options: { edge: "start" | "end"; advanceAcrossAdjacentText: boolean },
): { node: Node; offset: number } {
    const parent = token.parentNode;
    if (!parent) {
        return { node: token, offset: 0 };
    }

    if (options.edge === "end") {
        const nextSibling = token.nextSibling;
        if (nextSibling?.nodeType === Node.TEXT_NODE && nextSibling.textContent?.startsWith(caretSpacerCharacter)) {
            return {
                node: nextSibling,
                offset: options.advanceAcrossAdjacentText ? Math.min(nextSibling.textContent.length, 2) : 1,
            };
        }

        return { node: parent, offset: childIndex + 1 };
    }

    const previousSibling = token.previousSibling;
    if (previousSibling?.nodeType === Node.TEXT_NODE && previousSibling.textContent?.endsWith(caretSpacerCharacter)) {
        return {
            node: previousSibling,
            offset: Math.max(0, previousSibling.textContent.length - (options.advanceAcrossAdjacentText ? 2 : 1)),
        };
    }

    if (options.advanceAcrossAdjacentText && previousSibling?.nodeType === Node.TEXT_NODE) {
        return { node: previousSibling, offset: Math.max(0, (previousSibling.textContent ?? "").length - 1) };
    }

    return { node: parent, offset: childIndex };
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
