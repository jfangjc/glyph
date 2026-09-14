import {
    findRenderedContentTextPosition,
    getRenderedContentBoundaryOffset,
    getRenderedContentLengthBeforeChild,
    getRenderedContentText,
} from "./rendered-content-dom";
import {
    getBlockContent,
    getBlockText,
} from "../blocks/view";
import { getElement } from "../../utils/dom";

type CaretHooks = {
    onBlockFocused?: (block: HTMLElement) => void;
};

let caretHooks: CaretHooks = {};
let pendingScrollReveal: { block: HTMLElement; mode: "comfortable" | "minimal" } | null = null;
let pendingScrollRevealFrame = 0;

export function configureCaret(hooks: CaretHooks): void {
    caretHooks = { ...caretHooks, ...hooks };
}

export function focusBlock(block: HTMLElement): void {
    focusBlockAtOffset(block, getBlockText(block).length);
}

export function focusBlockAtOffset(
    block: HTMLElement,
    offset: number,
    options: { scroll?: "comfortable" | "minimal" | "none" } = {},
): void {
    const editor = getElement<HTMLElement>("editor");
    const content = getBlockContent(block);
    const selection = document.getSelection();
    const range = document.createRange();
    const position = getTextPosition(content, offset);

    editor.focus({ preventScroll: true });

    range.setStart(position.node, position.offset);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    caretHooks.onBlockFocused?.(block);

    if (options.scroll !== "none") {
        scrollBlockIntoComfortableView(block, options.scroll ?? "comfortable");
    }
}

export function getCaretPositionFromPoint(clientX: number, clientY: number): { node: Node; offset: number } | null {
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

export function getCaretOffset(root: HTMLElement, anchorNode: Node, anchorOffset: number): number {
    if (anchorNode === root) {
        return getRenderedContentLengthBeforeChild(root, anchorOffset);
    }

    if (!root.contains(anchorNode)) {
        return getRenderedContentText(root).length;
    }

    return getRenderedContentBoundaryOffset(root, anchorNode, anchorOffset);
}

export function getTextPosition(root: HTMLElement, offset: number): { node: Node; offset: number } {
    const position = findRenderedContentTextPosition(root, Math.max(0, offset));

    if (position) {
        return position;
    }

    return { node: root, offset: root.childNodes.length };
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

function scrollBlockIntoComfortableView(block: HTMLElement, mode: "comfortable" | "minimal"): void {
    pendingScrollReveal = { block, mode };

    if (pendingScrollRevealFrame) {
        return;
    }

    pendingScrollRevealFrame = window.requestAnimationFrame(flushPendingScrollReveal);
}

function flushPendingScrollReveal(): void {
    pendingScrollRevealFrame = 0;
    const request = pendingScrollReveal;
    pendingScrollReveal = null;

    if (!request?.block.isConnected) {
        return;
    }

    const scroller = document.querySelector<HTMLElement>(".editor-shell");
    if (!scroller) {
        return;
    }

    const blockRect = request.block.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const topInset = request.mode === "comfortable" ? Math.min(64, scrollerRect.height * 0.12) : 18;
    const bottomInset = request.mode === "comfortable" ? Math.min(112, scrollerRect.height * 0.2) : 36;
    const minimumTop = scrollerRect.top + topInset;
    const maximumBottom = scrollerRect.bottom - bottomInset;
    const visibleHeight = maximumBottom - minimumTop;
    const selectionRect = getSelectionRectInsideBlock(request.block);
    const targetRect =
        request.mode === "minimal"
            ? selectionRect ?? blockRect
            : blockRect.height > visibleHeight
              ? selectionRect ?? blockRect
              : blockRect;

    if (targetRect.bottom > maximumBottom) {
        scroller.scrollTop += targetRect.bottom - maximumBottom;
        return;
    }

    if (targetRect.top < minimumTop) {
        scroller.scrollTop -= minimumTop - targetRect.top;
    }
}

function getSelectionRectInsideBlock(block: HTMLElement): DOMRect | null {
    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    const content = getBlockContent(block);

    if (!selection?.isCollapsed || !focusNode || (focusNode !== content && !content.contains(focusNode))) {
        return null;
    }

    return getCollapsedSelectionRect(selection);
}
