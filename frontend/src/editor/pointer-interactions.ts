import {
    createBlock,
    findBlock,
    getBlockContent,
    getBlockText,
    getEditorBlocks,
    getSiblingBlock,
} from "./blocks/view";
import { readBlockType } from "./blocks/model";
import {
    focusBlockAtOffset,
    focusPlainTextElement,
    getCaretOffset,
    getCaretPositionFromPoint,
    getPlainTextBoundaryOffset,
    getTextPosition,
} from "./selection/caret";
import { getBlockSourceElement } from "./blocks/rendering";
import { getElement } from "../utils/dom";
import { clamp } from "../utils/text";
import { readMarkdownTableCellRange } from "../formats/markdown/table";

type PointerBlockTarget = {
    block: HTMLElement;
    offset: number;
    sourcePosition?: { node: Node; offset: number };
    tableCell?: { lineIndex: number; cellIndex: number; progress: number };
};

type PointerDownSelection = {
    x: number;
    y: number;
    anchor: PointerBlockTarget | null;
};

type PointerInteractionHooks = {
    onBlockActivated?: (block: HTMLElement | null) => void;
};

let hooks: PointerInteractionHooks = {};
let gutterHoverBlock: HTMLElement | null = null;
let gutterHoverTimer = 0;
let pointerDownSelectionStart: PointerDownSelection | null = null;
let isPointerSelecting = false;
let pendingGutterHoverEvent: { x: number; y: number } | null = null;
let pendingGutterHoverFrame = 0;

const lineStartProbeWidth = 24;

export function configurePointerInteractions(nextHooks: PointerInteractionHooks): void {
    hooks = { ...hooks, ...nextHooks };
}

export function handleDocumentSurfaceMouseDown(event: MouseEvent): void {
    if (isWindowChromeEvent(event)) {
        return;
    }

    if (
        event.button !== 0 ||
        event.detail > 1 ||
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
    ) {
        return;
    }

    pointerDownSelectionStart = { x: event.clientX, y: event.clientY, anchor: null };
    setPointerSelecting(false);

    const target = event.target;
    if (!(target instanceof Element)) {
        return;
    }

    if (shouldLetBrowserHandlePointerTarget(target)) {
        return;
    }

    const pointerTarget = findPointerTargetBlock(target, event.clientX, event.clientY);
    if (!pointerTarget) {
        return;
    }

    event.preventDefault();
    pointerDownSelectionStart.anchor = pointerTarget;
    focusPointerTargetBlock(pointerTarget);
}

export function handleEditorMouseDown(event: MouseEvent): void {
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
    hooks.onBlockActivated?.(block);
}

export function handleDocumentMouseMove(event: MouseEvent): void {
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
        extendPointerSelection(event);
    }
}

export function handleDocumentMouseUp(): void {
    pointerDownSelectionStart = null;
    window.requestAnimationFrame(() => {
        const selection = document.getSelection();
        setPointerSelecting(Boolean(selection && !selection.isCollapsed));
    });
}

export function handleDocumentSurfaceMouseMove(event: MouseEvent): void {
    if (isWindowChromeEvent(event)) {
        return;
    }

    syncLinkOpenIntentFromMouse(event);
    requestGutterHover(event);
}

export function handleDocumentSurfaceMouseOver(event: MouseEvent): void {
    if (isWindowChromeEvent(event)) {
        return;
    }

    syncLinkOpenIntentFromMouse(event);
}

export function handleDocumentSurfaceMouseOut(event: MouseEvent): void {
    if (!(event.relatedTarget instanceof Element) || !getElement<HTMLElement>("document-surface").contains(event.relatedTarget)) {
        clearLinkOpenIntent();
    }
}

export function setPointerSelecting(selecting: boolean): void {
    if (isPointerSelecting === selecting) {
        return;
    }

    isPointerSelecting = selecting;
    getElement<HTMLElement>("editor").dataset.selecting = selecting ? "true" : "false";

    if (selecting) {
        clearGutterHoverBlock();
    }
}

export function clearGutterHoverBlock(): void {
    pendingGutterHoverEvent = null;
    if (pendingGutterHoverFrame) {
        window.cancelAnimationFrame(pendingGutterHoverFrame);
        pendingGutterHoverFrame = 0;
    }

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

export function syncLinkOpenIntentFromKeyboard(event: KeyboardEvent): void {
    getElement<HTMLElement>("editor").dataset.linkOpenIntent = event.ctrlKey || event.metaKey ? "true" : "false";
}

export function clearLinkOpenIntent(): void {
    getElement<HTMLElement>("editor").dataset.linkOpenIntent = "false";
}

function isWindowChromeEvent(event: MouseEvent): boolean {
    return event.target instanceof Element && Boolean(event.target.closest(".app-titlebar"));
}

function shouldLetBrowserHandlePointerTarget(target: Element): boolean {
    if (target.closest(".markdown-table-preview, .markdown-math-preview, .markdown-html-preview")) {
        return false;
    }

    if (target.closest(".markdown-token-editing")) {
        return true;
    }

    return Boolean(
        target.closest(
            "#document-title, .todo-checkbox, button, input, textarea, select, [contenteditable='false']",
        ),
    );
}

function findPointerTargetBlock(target: Element, clientX: number, clientY: number): PointerBlockTarget | null {
    const directBlock = findBlock(target);
    if (directBlock) {
        const markerColumnTarget = findAdjacentBlockFromActiveListMarkerColumn(directBlock, clientX, clientY);
        if (markerColumnTarget) {
            return markerColumnTarget;
        }

        const sourcePosition = readPointerBlockSourcePosition(directBlock, clientX, clientY);
        return {
            block: directBlock,
            offset: getPointerCaretOffset(directBlock, clientX, clientY),
            sourcePosition,
            tableCell: readTableCellPointerTarget(target, clientX),
        };
    }

    const pointTarget = document.elementFromPoint(clientX, clientY);
    const pointBlock = pointTarget instanceof Element ? findBlock(pointTarget) : null;
    if (pointBlock) {
        const sourcePosition = readPointerBlockSourcePosition(pointBlock, clientX, clientY);
        return {
            block: pointBlock,
            offset: getPointerCaretOffset(pointBlock, clientX, clientY),
            sourcePosition,
            tableCell: pointTarget instanceof Element ? readTableCellPointerTarget(pointTarget, clientX) : undefined,
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
            const sourcePosition = readPointerBlockSourcePosition(block, clientX, clientY);
            return {
                block,
                offset: getPointerCaretOffset(block, clientX, clientY),
                sourcePosition,
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

function extendPointerSelection(event: MouseEvent): void {
    const anchor = pointerDownSelectionStart?.anchor;
    if (!anchor) {
        return;
    }

    const target = readPointerEventTarget(event);
    const focus = findPointerTargetBlock(target, event.clientX, event.clientY);
    if (!focus) {
        return;
    }

    event.preventDefault();
    selectPointerTargetRange(anchor, focus);
}

function readPointerEventTarget(event: MouseEvent): Element {
    if (event.target instanceof Element) {
        return event.target;
    }

    const pointTarget = document.elementFromPoint(event.clientX, event.clientY);
    return pointTarget instanceof Element ? pointTarget : getElement<HTMLElement>("document-surface");
}

function selectPointerTargetRange(anchor: PointerBlockTarget, focus: PointerBlockTarget): void {
    const selection = document.getSelection();
    if (!selection) {
        return;
    }

    const range = document.createRange();
    const anchorPosition = getPointerTargetTextPosition(anchor);
    const focusPosition = getPointerTargetTextPosition(focus);

    getElement<HTMLElement>("editor").focus({ preventScroll: true });
    range.setStart(anchorPosition.node, anchorPosition.offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    selection.extend(focusPosition.node, focusPosition.offset);
    hooks.onBlockActivated?.(focus.block);
}

function getPointerTargetTextPosition(target: PointerBlockTarget): { node: Node; offset: number } {
    if (target.sourcePosition) {
        return target.sourcePosition;
    }

    return getTextPosition(getBlockContent(target.block), target.offset);
}

function readPointerBlockSourcePosition(
    block: HTMLElement,
    clientX: number,
    clientY: number,
): { node: Node; offset: number } | undefined {
    if (block.dataset.blockSourceActive !== "true") {
        return undefined;
    }

    for (const source of Array.from(getBlockContent(block).querySelectorAll<HTMLElement>(".format-block-source"))) {
        if (source.getAttribute("contenteditable") === "false" || !isPointInsideSourceBand(block, source, clientX, clientY)) {
            continue;
        }

        const offset = readPointerPlainTextOffset(source, clientX, clientY);
        return getTextPosition(source, offset);
    }

    return undefined;
}

function readPointerPlainTextOffset(source: HTMLElement, clientX: number, clientY: number): number {
    const rect = source.getBoundingClientRect();
    const caretPosition = getCaretPositionFromPoint(
        clamp(clientX, rect.left + 1, rect.right - 1),
        clamp(clientY, rect.top + 1, rect.bottom - 1),
    );

    if (caretPosition && (caretPosition.node === source || source.contains(caretPosition.node))) {
        return getPlainTextBoundaryOffset(source, caretPosition.node, caretPosition.offset);
    }

    return clientX <= rect.left + rect.width / 2 ? 0 : (source.textContent?.length ?? 0);
}

function findAdjacentBlockFromActiveListMarkerColumn(
    block: HTMLElement,
    clientX: number,
    clientY: number,
): PointerBlockTarget | null {
    if (block.dataset.blockSourceActive !== "true") {
        return null;
    }

    const type = readBlockType(block.dataset.type);
    if (type !== "list" && type !== "ordered-list" && type !== "todo") {
        return null;
    }

    const content = getBlockContent(block);
    const prefix = getBlockSourceElement(content, "prefix");
    if (!prefix) {
        return null;
    }

    const prefixRect = prefix.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    if (prefixRect.width <= 0 || prefixRect.height <= 0) {
        return null;
    }

    const isInMarkerColumn = clientX >= Math.min(prefixRect.left, contentRect.left) && clientX <= prefixRect.right + 4;
    if (!isInMarkerColumn) {
        return null;
    }

    const verticalSlop = 0.5;
    const blockRect = block.getBoundingClientRect();

    if (clientY < prefixRect.top - verticalSlop && clientY < blockRect.top + readListMarkerColumnEdgeBand(blockRect, prefixRect)) {
        const previous = getSiblingBlock(block, "previous");
        return previous ? { block: previous, offset: 0 } : null;
    }

    if (clientY > prefixRect.bottom + verticalSlop && clientY > blockRect.bottom - readListMarkerColumnEdgeBand(blockRect, prefixRect)) {
        const next = getSiblingBlock(block, "next");
        return next ? { block: next, offset: 0 } : null;
    }

    return null;
}

function readListMarkerColumnEdgeBand(blockRect: DOMRect, prefixRect: DOMRect): number {
    return Math.max(2, Math.min(8, (blockRect.height - prefixRect.height) + 1));
}

function isPointInsideSourceBand(block: HTMLElement, source: HTMLElement, clientX: number, clientY: number): boolean {
    const rect = source.getBoundingClientRect();
    if (source.classList.contains("format-block-source-prefix") && isPointInPrefixLineStartBand(block, rect, clientX, clientY)) {
        return true;
    }

    const inlineSlop = 2;
    const blockSlop = 2;

    return (
        rect.width > 0 &&
        rect.height > 0 &&
        clientX >= rect.left - inlineSlop &&
        clientX <= rect.right + 2 &&
        clientY >= rect.top - blockSlop &&
        clientY <= rect.bottom + blockSlop
    );
}

function isPointInPrefixLineStartBand(
    block: HTMLElement,
    sourceRect: DOMRect,
    clientX: number,
    clientY: number,
): boolean {
    if (sourceRect.width <= 0 || sourceRect.height <= 0) {
        return false;
    }

    const contentRect = getBlockContent(block).getBoundingClientRect();
    const leftBoundary = Math.min(sourceRect.left, contentRect.left);
    const rightBoundary = sourceRect.right + 4;
    const verticalSlop = 0.5;
    const topBoundary = Math.max(Math.min(contentRect.top, sourceRect.top), sourceRect.top - verticalSlop);
    const bottomBoundary = Math.min(Math.max(contentRect.bottom, sourceRect.bottom), sourceRect.bottom + verticalSlop);

    return (
        clientX >= leftBoundary &&
        clientX <= rightBoundary &&
        clientY >= topBoundary &&
        clientY <= bottomBoundary
    );
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

    return nextBlock;
}

function getPointerCaretOffset(block: HTMLElement, clientX: number, clientY: number): number {
    const content = getBlockContent(block);
    const rect = content.getBoundingClientRect();
    const clampedX = clamp(clientX, rect.left + 1, rect.right - 1);
    const clampedY = clamp(clientY, rect.top + 1, rect.bottom - 1);
    const caretPosition = getCaretPositionFromPoint(clampedX, clampedY);

    if (caretPosition && (caretPosition.node === content || content.contains(caretPosition.node))) {
        const offset = getCaretOffset(content, caretPosition.node, caretPosition.offset);
        return snapPointerCaretOffsetToLineStart(content, offset, clientX, clientY);
    }

    if (clientY < rect.top || clientX <= rect.left) {
        return 0;
    }

    return getBlockText(block).length;
}

function snapPointerCaretOffsetToLineStart(
    content: HTMLElement,
    offset: number,
    clientX: number,
    clientY: number,
): number {
    if (offset <= 0) {
        return offset;
    }

    const contentRect = content.getBoundingClientRect();
    if (clientX > contentRect.left + lineStartProbeWidth) {
        return offset;
    }

    const caretRect = getCaretRectForOffset(content, offset);
    if (!caretRect) {
        return offset;
    }

    const lineStartOffset = findCaretLineStartOffset(content, offset, caretRect);
    if (lineStartOffset === offset) {
        return offset;
    }

    const lineStartRect = getCaretRectForOffset(content, lineStartOffset);
    if (!lineStartRect || !isPointOnCaretLine(lineStartRect, clientY)) {
        return offset;
    }

    const snapWidth = getLineStartSnapWidth(content, lineStartOffset, lineStartRect);
    return clientX <= lineStartRect.left + snapWidth ? lineStartOffset : offset;
}

function findCaretLineStartOffset(content: HTMLElement, offset: number, caretRect: DOMRect): number {
    let lineStartOffset = offset;

    while (lineStartOffset > 0) {
        const previousRect = getCaretRectForOffset(content, lineStartOffset - 1);
        if (!previousRect || !areCaretRectsOnSameLine(caretRect, previousRect)) {
            break;
        }

        lineStartOffset -= 1;
    }

    return lineStartOffset;
}

function getLineStartSnapWidth(content: HTMLElement, lineStartOffset: number, lineStartRect: DOMRect): number {
    const firstCharacterRect = getTextRangeRect(content, lineStartOffset, lineStartOffset + 1, lineStartRect);
    if (!firstCharacterRect) {
        return 12;
    }

    return clamp(firstCharacterRect.right - lineStartRect.left + 2, 8, 22);
}

function getCaretRectForOffset(content: HTMLElement, offset: number): DOMRect | null {
    const range = document.createRange();
    const position = getTextPosition(content, offset);

    range.setStart(position.node, position.offset);
    range.collapse(true);

    return readVisibleRangeRect(range);
}

function getTextRangeRect(
    content: HTMLElement,
    startOffset: number,
    endOffset: number,
    lineRect: DOMRect,
): DOMRect | null {
    const range = document.createRange();
    const start = getTextPosition(content, startOffset);
    const end = getTextPosition(content, endOffset);

    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);

    return Array.from(range.getClientRects()).find((rect) => isVisibleRect(rect) && areCaretRectsOnSameLine(lineRect, rect)) ?? null;
}

function readVisibleRangeRect(range: Range): DOMRect | null {
    const rect = Array.from(range.getClientRects()).find(isVisibleRect);
    if (rect) {
        return rect;
    }

    const boundingRect = range.getBoundingClientRect();
    return isVisibleRect(boundingRect) ? boundingRect : null;
}

function isVisibleRect(rect: DOMRect): boolean {
    return rect.width > 0 || rect.height > 0;
}

function isPointOnCaretLine(rect: DOMRect, clientY: number): boolean {
    return clientY >= rect.top - 2 && clientY <= rect.bottom + 2;
}

function areCaretRectsOnSameLine(first: DOMRect, second: DOMRect): boolean {
    const overlap = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
    return overlap > Math.min(first.height || 1, second.height || 1) * 0.5;
}

function focusPointerTargetBlock(pointerTarget: PointerBlockTarget): void {
    if (pointerTarget.sourcePosition) {
        const selection = document.getSelection();
        if (!selection) {
            return;
        }

        const range = document.createRange();
        const editor = getElement<HTMLElement>("editor");
        pointerTarget.block.dataset.blockSourceActive = "true";
        editor.focus({ preventScroll: true });
        range.setStart(pointerTarget.sourcePosition.node, pointerTarget.sourcePosition.offset);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        hooks.onBlockActivated?.(pointerTarget.block);
        return;
    }

    if (focusAtomicPreviewSource(pointerTarget)) {
        return;
    }

    focusBlockAtOffset(pointerTarget.block, pointerTarget.offset, { scroll: "minimal" });
}

function focusAtomicPreviewSource(pointerTarget: PointerBlockTarget): boolean {
    const type = readBlockType(pointerTarget.block.dataset.type);
    if (type !== "table" && type !== "definition-list" && type !== "math" && type !== "html") {
        return false;
    }

    const source = getBlockSourceElement(getBlockContent(pointerTarget.block), "atomic");
    if (!source) {
        return false;
    }

    pointerTarget.block.dataset.blockSourceActive = "true";
    const sourceLength = source.textContent?.length ?? 0;
    const tableCellOffset = type === "table"
        ? readTableCellSourceOffset(source.textContent ?? "", pointerTarget.tableCell)
        : null;
    focusPlainTextElement(
        source,
        tableCellOffset ?? (pointerTarget.offset <= 0 ? 0 : sourceLength),
    );
    hooks.onBlockActivated?.(pointerTarget.block);
    return true;
}

function readTableCellPointerTarget(
    target: Element,
    clientX: number,
): PointerBlockTarget["tableCell"] {
    const cell = target.closest<HTMLElement>("[data-table-source-row][data-table-source-column]");
    const lineIndex = cell ? Number(cell.dataset.tableSourceRow) : Number.NaN;
    const cellIndex = cell ? Number(cell.dataset.tableSourceColumn) : Number.NaN;
    if (!cell || !Number.isInteger(lineIndex) || !Number.isInteger(cellIndex)) {
        return undefined;
    }

    const rect = cell.getBoundingClientRect();
    return {
        lineIndex,
        cellIndex,
        progress: rect.width > 0 ? clamp((clientX - rect.left) / rect.width, 0, 1) : 0,
    };
}

function readTableCellSourceOffset(
    source: string,
    target: PointerBlockTarget["tableCell"],
): number | null {
    if (!target) {
        return null;
    }

    const range = readMarkdownTableCellRange(source, target.lineIndex, target.cellIndex);
    if (!range) {
        return null;
    }

    return range.start + Math.round((range.end - range.start) * target.progress);
}

function requestGutterHover(event: MouseEvent): void {
    pendingGutterHoverEvent = { x: event.clientX, y: event.clientY };

    if (pendingGutterHoverFrame) {
        return;
    }

    pendingGutterHoverFrame = window.requestAnimationFrame(() => {
        pendingGutterHoverFrame = 0;
        const pending = pendingGutterHoverEvent;
        pendingGutterHoverEvent = null;

        if (pending) {
            scheduleGutterHover(pending.x, pending.y);
        }
    });
}

function scheduleGutterHover(clientX: number, clientY: number): void {
    if (isPointerSelecting) {
        clearGutterHoverBlock();
        return;
    }

    const block = findGutterHoverBlock(clientX, clientY);
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
    if (!isPointerNearGutterBand(clientX)) {
        return null;
    }

    const pointTarget = document.elementFromPoint(clientX + 34, clientY);
    const pointBlock = pointTarget instanceof Element ? findBlock(pointTarget) : null;
    if (pointBlock) {
        return isPointInBlockGutter(pointBlock, clientX, clientY) ? pointBlock : null;
    }

    for (const block of getEditorBlocks()) {
        const blockRect = block.getBoundingClientRect();
        if (clientY < blockRect.top || clientY > blockRect.bottom) {
            continue;
        }

        if (isPointInBlockGutter(block, clientX, clientY)) {
            return block;
        }
    }

    return null;
}

function isPointerNearGutterBand(clientX: number): boolean {
    const editorRect = getElement<HTMLElement>("editor").getBoundingClientRect();
    return clientX >= editorRect.left - 48 && clientX <= editorRect.left + 64;
}

function isPointInBlockGutter(block: HTMLElement, clientX: number, clientY: number): boolean {
    const blockRect = block.getBoundingClientRect();
    if (clientY < blockRect.top || clientY > blockRect.bottom) {
        return false;
    }

    const contentRect = getBlockContent(block).getBoundingClientRect();
    return clientX >= contentRect.left - 34 && clientX <= contentRect.left - 4;
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

function syncLinkOpenIntentFromMouse(event: MouseEvent): void {
    const target = event.target;
    const hasLinkIntent = target instanceof Element && Boolean(target.closest("a.markdown-link")) && (event.ctrlKey || event.metaKey);

    getElement<HTMLElement>("editor").dataset.linkOpenIntent = hasLinkIntent ? "true" : "false";
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
