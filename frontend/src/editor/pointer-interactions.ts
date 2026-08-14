import {
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
    getTextPosition,
} from "./selection/caret";
import { getBlockSourceElement } from "./blocks/rendering";
import { getElement, getPlainTextBoundaryOffset } from "../utils/dom";
import { clamp } from "../utils/text";
import { nextGraphemeBoundary, previousGraphemeBoundary } from "../utils/text-boundaries";
import type { ProjectionCapability } from "./core/types";
import {
    activateSourceToken,
    readSourceTokenEditOffsetFromPreviewOffset,
    readSourceTokenDocumentRange,
    syncDomSelectionFromState,
    syncStateSelectionFromDom,
} from "./core/projection";
import { dispatch } from "./core/store";

type PointerBlockTarget = {
    block: HTMLElement;
    offset: number;
    sourcePosition?: { node: Node; offset: number };
    pointerElement?: Element;
    clientX?: number;
    clientY?: number;
    virtualEof?: boolean;
};

type PointerDownSelection = {
    x: number;
    y: number;
    anchor: PointerBlockTarget | null;
};

type PointerInteractionHooks = {
    onBlockActivated?: (block: HTMLElement | null) => void;
    getProjectionCapability?: () => ProjectionCapability | undefined;
};

let hooks: PointerInteractionHooks = {};
let gutterHoverBlock: HTMLElement | null = null;
let gutterHoverTimer = 0;
let pointerDownSelectionStart: PointerDownSelection | null = null;
let isPointerSelecting = false;
let pendingGutterHoverEvent: { x: number; y: number } | null = null;
let pendingGutterHoverFrame = 0;
let pointerAutoScrollFrame = 0;
let lastPointerSelectionEvent: MouseEvent | null = null;
let capturedPointer: { element: Element; pointerId: number } | null = null;
let recentPrimaryPointerDown: {
    timestamp: number;
    x: number;
    y: number;
    pointerId: number;
    count: number;
} | null = null;

const lineStartProbeWidth = 24;
const multiClickDelayMs = 500;
const multiClickRadiusPx = 6;

export function configurePointerInteractions(nextHooks: PointerInteractionHooks): void {
    hooks = { ...hooks, ...nextHooks };
}

export function handleDocumentSurfaceMouseDown(event: PointerEvent): void {
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
    const captureElement = event.currentTarget;
    if (captureElement instanceof Element && "setPointerCapture" in captureElement) {
        captureElement.setPointerCapture(event.pointerId);
        capturedPointer = { element: captureElement, pointerId: event.pointerId };
    }
    pointerDownSelectionStart.anchor = pointerTarget;
    focusPointerTargetBlock(pointerTarget);
}

export function handleEditorMouseDown(event: PointerEvent): void {
    if (isWindowChromeEvent(event)) {
        return;
    }

    if (event.button !== 0 || event.defaultPrevented) {
        return;
    }

    const clickCount = readPrimaryPointerClickCount(event);
    if (clickCount < 2) {
        return;
    }

    if (clickCount === 2) {
        const token = event.target instanceof Element
            ? event.target.closest<HTMLElement>(".markdown-token[data-source-atomic='true']")
            : null;
        const range = token ? readSourceTokenDocumentRange(token) : null;
        if (range) {
            event.preventDefault();
            dispatch({
                changes: [],
                selection: { anchor: range.from, head: range.to },
                annotations: { userEvent: "programmatic", addToHistory: false },
            });
            syncDomSelectionFromState({ focus: "editor" });
            setPointerSelecting(true);
            return;
        }

        const target = event.target;
        const plainTextTarget = target instanceof Element
            ? target.closest<HTMLElement>(
                ".markdown-token-editing, " +
                ".markdown-token[data-source-raw], " +
                ".format-block-source[data-block-source-editable='true']",
            )
            : null;
        if (plainTextTarget && selectPlainTextWord(plainTextTarget, event.clientX, event.clientY)) {
            event.preventDefault();
            syncStateSelectionFromDom();
            hooks.onBlockActivated?.(findBlock(plainTextTarget));
            setPointerSelecting(true);
            return;
        }

        const pointerTarget = target instanceof Element
            ? findPointerTargetBlock(target, event.clientX, event.clientY)
            : null;
        const wordRange = pointerTarget ? findWordRange(getBlockText(pointerTarget.block), pointerTarget.offset) : null;
        if (!pointerTarget || !wordRange) {
            return;
        }

        event.preventDefault();
        selectPointerTargetRange(
            { block: pointerTarget.block, offset: wordRange.from },
            { block: pointerTarget.block, offset: wordRange.to },
        );
        syncStateSelectionFromDom();
        setPointerSelecting(true);
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

function readPrimaryPointerClickCount(event: PointerEvent): number {
    const previous = recentPrimaryPointerDown;
    const elapsed = previous ? event.timeStamp - previous.timestamp : Number.POSITIVE_INFINITY;
    const distanceSquared = previous
        ? ((event.clientX - previous.x) ** 2) + ((event.clientY - previous.y) ** 2)
        : Number.POSITIVE_INFINITY;
    const continuesSequence = Boolean(
        previous &&
        previous.pointerId === event.pointerId &&
        elapsed >= 0 &&
        elapsed <= multiClickDelayMs &&
        distanceSquared <= multiClickRadiusPx ** 2,
    );
    const count = continuesSequence ? Math.min(previous!.count + 1, 3) : 1;

    recentPrimaryPointerDown = {
        timestamp: event.timeStamp,
        x: event.clientX,
        y: event.clientY,
        pointerId: event.pointerId,
        count,
    };
    return count;
}

export function handleDocumentMouseMove(event: PointerEvent): void {
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
        lastPointerSelectionEvent = event;
        extendPointerSelection(event);
        requestPointerAutoScroll();
    }
}

function findWordRange(text: string, offset: number): { from: number; to: number } | null {
    const point = clamp(offset, 0, text.length);
    if (typeof Intl.Segmenter === "function") {
        const segments = new Intl.Segmenter(undefined, { granularity: "word" }).segment(text);
        for (const segment of segments) {
            const from = segment.index;
            const to = from + segment.segment.length;
            if (segment.isWordLike && point >= from && point <= to) {
                return { from, to };
            }
        }
        return null;
    }

    for (const match of text.matchAll(/[\p{L}\p{M}\p{N}_]+/gu)) {
        const from = match.index;
        const to = from + match[0].length;
        if (point >= from && point <= to) {
            return { from, to };
        }
    }
    return null;
}

function selectPlainTextWord(target: HTMLElement, clientX: number, clientY: number): boolean {
    const wordRange = findWordRange(
        target.textContent ?? "",
        readPointerPlainTextOffset(target, clientX, clientY),
    );
    const selection = document.getSelection();
    if (!wordRange || !selection) {
        return false;
    }

    const start = getPlainTextSourcePosition(target, wordRange.from);
    const end = getPlainTextSourcePosition(target, wordRange.to);
    const range = document.createRange();
    getElement<HTMLElement>("editor").focus({ preventScroll: true });
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
}

export function handleDocumentMouseUp(): void {
    if (
        capturedPointer &&
        "hasPointerCapture" in capturedPointer.element &&
        capturedPointer.element.hasPointerCapture(capturedPointer.pointerId)
    ) {
        capturedPointer.element.releasePointerCapture(capturedPointer.pointerId);
    }
    capturedPointer = null;
    pointerDownSelectionStart = null;
    lastPointerSelectionEvent = null;
    if (pointerAutoScrollFrame) {
        window.cancelAnimationFrame(pointerAutoScrollFrame);
        pointerAutoScrollFrame = 0;
    }
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
    const formatPreference = hooks.getProjectionCapability?.()?.shouldUseNativePointer?.(target);
    if (formatPreference !== null && formatPreference !== undefined) {
        return formatPreference;
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
            pointerElement: target,
            clientX,
            clientY,
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
            pointerElement: pointTarget instanceof Element ? pointTarget : undefined,
            clientX,
            clientY,
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
                clientX,
                clientY,
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

    return {
        block: previousBlock,
        offset: getBlockText(previousBlock).length,
        virtualEof: true,
    };
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
    const pointTarget = document.elementFromPoint(event.clientX, event.clientY);
    if (pointTarget instanceof Element) {
        return pointTarget;
    }
    return event.target instanceof Element ? event.target : getElement<HTMLElement>("document-surface");
}

function requestPointerAutoScroll(): void {
    if (pointerAutoScrollFrame) {
        return;
    }
    pointerAutoScrollFrame = window.requestAnimationFrame(runPointerAutoScroll);
}

function runPointerAutoScroll(): void {
    pointerAutoScrollFrame = 0;
    const event = lastPointerSelectionEvent;
    if (!event || !pointerDownSelectionStart) {
        return;
    }

    const shell = document.querySelector<HTMLElement>(".editor-shell");
    if (!shell) {
        return;
    }
    const rect = shell.getBoundingClientRect();
    const overflow = event.clientY < rect.top
        ? event.clientY - rect.top
        : event.clientY > rect.bottom ? event.clientY - rect.bottom : 0;
    if (overflow !== 0) {
        const speed = clamp(overflow * 0.28, -24, 24);
        shell.scrollTop += speed;
        extendPointerSelection(event);
    }
    requestPointerAutoScroll();
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
        if (!isPointOnInactiveListMarker(block, clientX, clientY)) {
            return undefined;
        }
        block.dataset.blockSourceActive = "true";
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

function isPointOnInactiveListMarker(block: HTMLElement, clientX: number, clientY: number): boolean {
    const type = readBlockType(block.dataset.type);
    if (type !== "list" && type !== "ordered-list") {
        return false;
    }

    const blockRect = block.getBoundingClientRect();
    const content = getBlockContent(block);
    const contentRect = content.getBoundingClientRect();
    const computedLineHeight = Number.parseFloat(window.getComputedStyle(content).lineHeight);
    const markerLineHeight = Number.isFinite(computedLineHeight) ? Math.max(24, computedLineHeight) : 24;
    const markerLineBottom = Math.min(blockRect.bottom, contentRect.top + markerLineHeight);
    return (
        clientX >= blockRect.left - 2 &&
        clientX < contentRect.left &&
        clientY >= contentRect.top - 2 &&
        clientY <= markerLineBottom + 2
    );
}

function readPointerPlainTextOffset(source: HTMLElement, clientX: number, clientY: number): number {
    const rect = source.getBoundingClientRect();
    if (rect.width <= 2 || rect.height <= 2) {
        return clientX <= rect.left + rect.width / 2 ? 0 : (source.textContent?.length ?? 0);
    }
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
    const rightBoundary = sourceRect.right + 4;
    const verticalSlop = 0.5;
    const topBoundary = Math.max(Math.min(contentRect.top, sourceRect.top), sourceRect.top - verticalSlop);
    const bottomBoundary = Math.min(Math.max(contentRect.bottom, sourceRect.bottom), sourceRect.bottom + verticalSlop);

    return (
        clientX <= rightBoundary &&
        clientY >= topBoundary &&
        clientY <= bottomBoundary
    );
}

function getPointerCaretOffset(block: HTMLElement, clientX: number, clientY: number): number {
    const content = getBlockContent(block);
    const rect = content.getBoundingClientRect();
    const clampedX = rect.width > 2
        ? clamp(clientX, rect.left + 1, rect.right - 1)
        : rect.left + rect.width / 2;
    const clampedY = rect.height > 2
        ? clamp(clientY, rect.top + 1, rect.bottom - 1)
        : rect.top + rect.height / 2;
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
    const isRtl = getComputedStyle(content).direction === "rtl";
    if (
        (!isRtl && clientX > contentRect.left + lineStartProbeWidth) ||
        (isRtl && clientX < contentRect.right - lineStartProbeWidth)
    ) {
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
    return isRtl
        ? clientX >= lineStartRect.right - snapWidth ? lineStartOffset : offset
        : clientX <= lineStartRect.left + snapWidth ? lineStartOffset : offset;
}

function findCaretLineStartOffset(content: HTMLElement, offset: number, caretRect: DOMRect): number {
    let lineStartOffset = offset;
    const text = getBlockText(findBlock(content) ?? content);

    while (lineStartOffset > 0) {
        const previousOffset = previousGraphemeBoundary(text, lineStartOffset);
        const previousRect = getCaretRectForOffset(content, previousOffset);
        if (!previousRect || !areCaretRectsOnSameLine(caretRect, previousRect)) {
            break;
        }

        lineStartOffset = previousOffset;
    }

    return lineStartOffset;
}

function getLineStartSnapWidth(content: HTMLElement, lineStartOffset: number, lineStartRect: DOMRect): number {
    const text = getBlockText(findBlock(content) ?? content);
    const firstCharacterRect = getTextRangeRect(
        content,
        lineStartOffset,
        nextGraphemeBoundary(text, lineStartOffset),
        lineStartRect,
    );
    if (!firstCharacterRect) {
        return 12;
    }

    return clamp(firstCharacterRect.width + 2, 8, 22);
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
    const editor = getElement<HTMLElement>("editor");
    editor.dataset.virtualEofCaret = pointerTarget.virtualEof ? "true" : "false";
    if (pointerTarget.sourcePosition) {
        const selection = document.getSelection();
        if (!selection) {
            return;
        }

        const range = document.createRange();
        pointerTarget.block.dataset.blockSourceActive = "true";
        editor.focus({ preventScroll: true });
        range.setStart(pointerTarget.sourcePosition.node, pointerTarget.sourcePosition.offset);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        hooks.onBlockActivated?.(pointerTarget.block);
        return;
    }

    if (focusVisualInlinePreviewSource(pointerTarget)) {
        return;
    }

    if (focusAtomicPreviewSource(pointerTarget)) {
        return;
    }

    focusBlockAtOffset(pointerTarget.block, pointerTarget.offset, { scroll: "minimal" });
}

function focusVisualInlinePreviewSource(pointerTarget: PointerBlockTarget): boolean {
    let token = pointerTarget.pointerElement?.closest<HTMLElement>(".markdown-token[data-source-raw]") ?? null;
    while (token?.parentElement?.closest<HTMLElement>(".markdown-token[data-source-raw]")) {
        token = token.parentElement.closest<HTMLElement>(".markdown-token[data-source-raw]");
    }
    if (
        !token ||
        pointerTarget.clientX === undefined ||
        pointerTarget.clientY === undefined
    ) {
        return false;
    }

    const rawSource = token.dataset.sourceRaw ?? "";
    const contentFrom = Number.parseInt(token.dataset.sourceContentFrom ?? "", 10);
    const contentTo = Number.parseInt(token.dataset.sourceContentTo ?? "", 10);
    const isAtomic = token.dataset.sourceAtomic === "true" || !Number.isFinite(contentFrom) || !Number.isFinite(contentTo);
    const rect = token.getBoundingClientRect();
    const isRtl = window.getComputedStyle(token).direction === "rtl";
    const afterMidpoint = isRtl
        ? pointerTarget.clientX < rect.left + rect.width / 2
        : pointerTarget.clientX > rect.left + rect.width / 2;
    const previewOffset = isAtomic
        ? readAtomicSourceEditOffset(rawSource, afterMidpoint)
        : readPointerPlainTextOffset(token, pointerTarget.clientX, pointerTarget.clientY);
    const sourceOffset = isAtomic
        ? previewOffset
        : readSourceTokenEditOffsetFromPreviewOffset(token, previewOffset);
    if (!activateSourceToken(token, sourceOffset)) {
        return false;
    }
    pointerTarget.sourcePosition = getPlainTextSourcePosition(token, sourceOffset);
    focusPlainTextElement(token, sourceOffset);
    hooks.onBlockActivated?.(pointerTarget.block);
    return true;
}

function focusAtomicPreviewSource(pointerTarget: PointerBlockTarget): boolean {
    const source = getBlockSourceElement(getBlockContent(pointerTarget.block), "atomic");
    if (!source) {
        return false;
    }

    pointerTarget.block.dataset.blockSourceActive = "true";
    const sourceLength = source.textContent?.length ?? 0;
    const semanticOffset = readAtomicPreviewSourceOffset(pointerTarget.pointerElement, sourceLength);
    const sourceOffset = semanticOffset ?? (
        pointerTarget.clientX !== undefined && pointerTarget.clientY !== undefined
            ? readPointerPlainTextOffset(source, pointerTarget.clientX, pointerTarget.clientY)
            : pointerTarget.offset <= 0 ? 0 : sourceLength
    );
    pointerTarget.sourcePosition = getPlainTextSourcePosition(source, sourceOffset);
    focusPlainTextElement(source, sourceOffset);
    hooks.onBlockActivated?.(pointerTarget.block);
    return true;
}

function readAtomicSourceEditOffset(rawSource: string, afterMidpoint: boolean): number {
    if (rawSource.length <= 1) {
        return 0;
    }

    return afterMidpoint ? rawSource.length - 1 : 1;
}

function readAtomicPreviewSourceOffset(target: Element | undefined, sourceLength: number): number | null {
    const value = target
        ?.closest<HTMLElement>("[data-atomic-source-offset]")
        ?.dataset.atomicSourceOffset;
    if (value === undefined) {
        return null;
    }

    const offset = Number.parseInt(value, 10);
    return Number.isFinite(offset) ? clamp(offset, 0, sourceLength) : null;
}

function getPlainTextSourcePosition(source: HTMLElement, offset: number): { node: Node; offset: number } {
    let remaining = Math.max(0, offset);
    const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    while (text) {
        const length = text.textContent?.length ?? 0;
        if (remaining <= length) {
            return { node: text, offset: remaining };
        }
        remaining -= length;
        text = walker.nextNode();
    }

    return { node: source, offset: source.childNodes.length };
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

function isPointInBlockGutter(block: HTMLElement, clientX: number, clientY: number): boolean {
    const blockRect = block.getBoundingClientRect();
    if (clientY < blockRect.top || clientY > blockRect.bottom) {
        return false;
    }

    const contentRect = getBlockContent(block).getBoundingClientRect();
    const editorRect = getElement<HTMLElement>("editor").getBoundingClientRect();
    const gutterLeft = Math.min(blockRect.left, editorRect.left);
    const gutterRight = Math.max(gutterLeft, contentRect.left - 4);
    return clientX >= gutterLeft && clientX <= gutterRight;
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
    const from = Number.parseInt(block.dataset.sourceFrom ?? "", 10);
    const to = Number.parseInt(block.dataset.sourceTo ?? "", 10);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
        return;
    }
    dispatch({
        changes: [],
        selection: { anchor: from, head: to },
        annotations: { userEvent: "programmatic", addToHistory: false },
    });
    syncDomSelectionFromState({ focus: "editor" });
    setPointerSelecting(true);
}
