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
    getCurrentBlockOffset,
    getTextPosition,
} from "../../../editor/selection/caret";
import { caretSpacerCharacter } from "../../../editor/selection/rendered-content-dom";
import { getElement } from "../../../utils/dom";
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
let pendingVerticalLeadingTokenNavigationRequestId = 0;
let pendingVerticalLeadingTokenNavigationTarget: { requestId: number } | null = null;

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
        hooks.syncBlockMarkdownSourceReveal?.(null);
        clearPendingMarkdownTokenNavigation();
        setPointerSelecting(true);
        return;
    }

    hooks.syncBlockMarkdownSourceReveal?.(focusBlock);

    const source = getFocusedMarkdownTokenSource();
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

function activateMarkdownTokenSource(
    token: HTMLElement,
    edge: "start" | "end" = "end",
    options: { advanceIntoSource?: boolean } = {},
): void {
    setActiveMarkdownToken(token);
    suppressSelectionChangeForFrame();
    focusMarkdownTokenSource(token, edge, options);
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

    const tokenPosition = findMarkdownTokenAtCaret(focusNode, selection.focusOffset, isEditableMarkdownToken);
    if (!tokenPosition) {
        return false;
    }

    activateMarkdownTokenSource(tokenPosition.token, tokenPosition.edge);
    return true;
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

export function suppressAdjacentFormatTokenActivation(block: HTMLElement, offset: number): void {
    const position = getTextPosition(getBlockContent(block), offset);
    const tokenPosition = findMarkdownTokenAtCaret(position.node, position.offset, isFormatMarkdownToken);

    if (tokenPosition) {
        const suppression = { block, offset };

        suppressedMarkdownTokenActivation = suppression;
        window.requestAnimationFrame(() => {
            if (suppressedMarkdownTokenActivation === suppression) {
                suppressedMarkdownTokenActivation = null;
            }
        });
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
}
