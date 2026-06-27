import {
    findRenderedContentTextPosition,
    getRenderedContentBoundaryOffset,
    getRenderedContentLengthBeforeChild,
    getRenderedContentText,
} from "./rendered-content-dom";
import {
    findBlock,
    getBlockContent,
    getEditorBlockRange,
    getBlockText,
    getEditorBlocks,
} from "../blocks/view";
import { getElement } from "../../utils/dom";
import {
    findBlockSourceElement,
    focusBlockSourceAtOffset as focusBlockSourceElementAtOffset,
    getBlockSourceOffset,
    isEditableBlockSourceElement,
    readBlockSourcePosition,
} from "../blocks/rendering";
import type { DocumentSourceSelectionTarget } from "../../formats/types";

export type SelectedBlockRange = {
    blocks: HTMLElement[];
    startBlock: HTMLElement;
    endBlock: HTMLElement;
    startOffset: number;
    endOffset: number;
    range: Range;
};

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

    editor.focus();

    range.setStart(position.node, position.offset);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    caretHooks.onBlockFocused?.(block);

    if (options.scroll !== "none") {
        scrollBlockIntoComfortableView(block, options.scroll ?? "comfortable");
    }
}

export function focusPlainTextElement(element: HTMLElement, offset: number): void {
    const selection = document.getSelection();
    const range = document.createRange();
    const text = element.firstChild ?? element.appendChild(document.createTextNode(""));

    range.setStart(text, Math.min(Math.max(0, offset), text.textContent?.length ?? 0));
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
}

export function readCurrentSourceSelectionTarget(): DocumentSourceSelectionTarget | null {
    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    if (!selection?.isCollapsed || !focusNode) {
        return null;
    }

    const blockSource = findBlockSourceElement(focusNode);
    if (blockSource && isEditableBlockSourceElement(blockSource)) {
        const target = createBlockSourceSelectionTarget(
            blockSource,
            getBlockSourceOffset(blockSource, focusNode, selection.focusOffset),
        );
        if (target) {
            return target;
        }
    }

    const focusElement = focusNode instanceof Element ? focusNode : focusNode.parentElement;
    const inlineSource = focusElement?.closest<HTMLElement>(".markdown-token-source") ?? null;
    const token = inlineSource?.parentElement;
    const block = token ? findBlock(token) : null;
    if (
        inlineSource &&
        token instanceof HTMLElement &&
        token.classList.contains("markdown-token") &&
        block &&
        !inlineSource.parentElement?.closest("[data-source-ignore='true']")
    ) {
        return {
            kind: "inline-source",
            block,
            token,
            source: inlineSource,
            sourceOffset: getPlainTextBoundaryOffset(inlineSource, focusNode, selection.focusOffset),
        };
    }

    return null;
}

export function focusSourceSelectionTarget(target: DocumentSourceSelectionTarget): void {
    if (!target.source.isConnected) {
        focusBlockAtOffset(target.block, Math.min(target.sourceOffset, getBlockText(target.block).length));
        return;
    }

    if (target.kind === "block-source") {
        focusBlockSourceElementAtOffset(target.source, target.sourceOffset);
        return;
    }

    focusPlainTextElement(target.source, target.sourceOffset);
}

export function isSelectionInsideEditableSource(): boolean {
    return readCurrentSourceSelectionTarget() !== null;
}

function createBlockSourceSelectionTarget(
    source: HTMLElement,
    sourceOffset: number,
): Extract<DocumentSourceSelectionTarget, { kind: "block-source" }> | null {
    const block = findBlock(source);
    const sourcePosition = readBlockSourcePosition(source);
    if (!block || !sourcePosition) {
        return null;
    }

    return {
        kind: "block-source",
        block,
        source,
        sourcePosition,
        sourceOffset: Math.min(Math.max(0, sourceOffset), source.textContent?.length ?? 0),
    };
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

export function getCurrentBlockOffset(block: HTMLElement): number {
    const content = getBlockContent(block);
    const selection = document.getSelection();

    if (selection?.focusNode && (selection.focusNode === content || content.contains(selection.focusNode))) {
        return getCaretOffset(content, selection.focusNode, selection.focusOffset);
    }

    return getBlockText(block).length;
}

export function getTextPosition(root: HTMLElement, offset: number): { node: Node; offset: number } {
    const position = findRenderedContentTextPosition(root, Math.max(0, offset));

    if (position) {
        return position;
    }

    return { node: root, offset: root.childNodes.length };
}

export function getActiveBlock(target: EventTarget | Node | null): HTMLElement | null {
    return findBlock(target) ?? findBlock(document.getSelection()?.focusNode ?? null);
}

export function getSelectedBlockRange(): SelectedBlockRange | null {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return null;
    }

    const range = selection.getRangeAt(0);
    const startBlock = findBlockFromBoundary(range.startContainer, range.startOffset, "start");
    const endBlock = findBlockFromBoundary(range.endContainer, range.endOffset, "end");
    const blocks = startBlock && endBlock ? getEditorBlockRange(startBlock, endBlock) : [];

    if (!startBlock || !endBlock || blocks.length === 0) {
        return null;
    }

    return {
        blocks,
        startBlock,
        endBlock,
        startOffset: getBoundaryOffset(startBlock, range.startContainer, range.startOffset, "start"),
        endOffset: getBoundaryOffset(endBlock, range.endContainer, range.endOffset, "end"),
        range: range.cloneRange(),
    };
}

export function getPlainTextBoundaryOffset(current: Node, anchorNode: Node, anchorOffset: number): number {
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

export function isCaretAtBlockEdge(block: HTMLElement, edge: "start" | "end"): boolean {
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

export function selectEditorContents(editor: HTMLElement): void {
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

export function readLineHeight(element: HTMLElement): number {
    const computedLineHeight = Number.parseFloat(window.getComputedStyle(element).lineHeight);
    return Number.isFinite(computedLineHeight) ? computedLineHeight : 24;
}

export function getCollapsedSelectionRect(selection: Selection): DOMRect | null {
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
    const targetRect =
        blockRect.height > visibleHeight ? getSelectionRectInsideBlock(request.block) ?? blockRect : blockRect;

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
