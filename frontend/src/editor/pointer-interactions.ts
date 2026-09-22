import {
    findBlock,
    getBlockContent,
    getBlockText,
    getEditorBlocks,
} from "./blocks/view";
import {
    focusBlockAtOffset,
    getCaretOffset,
    getCaretPositionFromPoint,
    getTextPosition,
} from "./selection/caret";
import {
    getBlockSourceElement,
    readBlockSourcePosition,
} from "./blocks/rendering";
import { getElement, getPlainTextBoundaryOffset } from "../utils/dom";
import { clamp } from "../utils/text";
import { nextGraphemeBoundary, previousGraphemeBoundary } from "../utils/text-boundaries";
import type { ProjectionCapability } from "./core/types";
import {
    domPointToSourceOffset,
    selectionTouchesSource,
    readSourceTokenEditOffsetFromPreviewOffset,
    readSourceTokenDocumentRange,
    sourceOffsetToDomPoint,
    setBlockSourceActive,
    syncDomSelectionFromState,
    syncStateSelectionFromDom,
} from "./core/projection";
import { dispatch, getEditorState } from "./core/store";

type PointerBlockTarget = {
    block: HTMLElement;
    offset: number;
    documentOffset?: number;
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
let pointerDownSelectionStart: PointerDownSelection | null = null;
let isPointerSelecting = false;
let pointerAutoScrollFrame = 0;
let lastPointerSelectionEvent: MouseEvent | null = null;
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
        event.metaKey
    ) {
        return;
    }

    pointerDownSelectionStart = { x: event.clientX, y: event.clientY, anchor: null };
    setPointerSelecting(false);

    const target = event.target;
    if (!(target instanceof Element)) {
        return;
    }

    const handlesShiftSelection = event.shiftKey && shouldHandleProjectedShiftSelection(target);
    if (shouldLetBrowserHandlePointerTarget(target) && !handlesShiftSelection) {
        return;
    }

    const pointerTarget = findPointerTargetBlock(target, event.clientX, event.clientY);
    if (!pointerTarget) {
        return;
    }

    if (event.shiftKey) {
        syncStateSelectionFromDom();
        const state = getEditorState();
        const head = readPointerTargetDocumentOffset(pointerTarget);
        if (head === null) {
            return;
        }
        event.preventDefault();
        pointerDownSelectionStart.anchor = {
            block: pointerTarget.block,
            offset: 0,
            documentOffset: state.selection.anchor,
        };
        extendSourceSelectionToOffset(state.selection.anchor, head, pointerTarget.block);
        return;
    }

    event.preventDefault();
    pointerDownSelectionStart.anchor = pointerTarget;
    focusPointerTargetBlock(pointerTarget);
}

function shouldHandleProjectedShiftSelection(target: Element): boolean {
    if (target.closest("button, input, textarea, select")) {
        return false;
    }
    return Boolean(findBlock(target));
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

        const punctuationSource = plainTextTarget?.closest<HTMLElement>(
            ".format-block-source[data-block-source-editable='true']",
        );
        if (punctuationSource && selectPlainTextContents(punctuationSource)) {
            event.preventDefault();
            syncStateSelectionFromDom();
            hooks.onBlockActivated?.(findBlock(punctuationSource));
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

function selectPlainTextContents(target: HTMLElement): boolean {
    const selection = document.getSelection();
    if (!selection || !(target.textContent?.length)) {
        return false;
    }

    const range = document.createRange();
    getElement<HTMLElement>("editor").focus({ preventScroll: true });
    range.selectNodeContents(target);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
}

export function handleDocumentMouseUp(): void {
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

export function clearGutterHoverBlock(): void {
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

    // Rendered inline tokens are non-editable DOM projections, so clicks on
    // them must still pass through our source-position mapping instead of
    // letting the browser collapse selection against the token element box.
    // Formats can opt specific projected tokens (images, math, etc.) back into
    // native pointer handling above.
    if (target.closest(".markdown-token[data-source-raw]")) {
        return false;
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
        return resolvePointerBlockTarget(directBlock, target, clientX, clientY);
    }

    const pointTarget = document.elementFromPoint(clientX, clientY);
    const pointBlock = pointTarget instanceof Element ? findBlock(pointTarget) : null;
    if (pointBlock) {
        return resolvePointerBlockTarget(pointBlock, pointTarget, clientX, clientY);
    }

    const blocks = getEditorBlocks();
    if (blocks.length === 0) {
        return null;
    }

    const firstBlock = blocks[0];
    const firstRect = firstBlock.getBoundingClientRect();
    if (clientY < firstRect.top) {
        return resolvePointerBlockTarget(
            firstBlock,
            null,
            clientX,
            clampPointerYToBlock(firstBlock, clientY),
            0,
        );
    }

    let previousBlock = firstBlock;
    for (const block of blocks) {
        const rect = block.getBoundingClientRect();

        if (clientY >= rect.top && clientY <= rect.bottom) {
            const pointElement = pointTarget instanceof Element ? pointTarget : null;
            return resolvePointerBlockTarget(block, pointElement, clientX, clientY);
        }

        if (clientY < rect.top) {
            const previousRect = previousBlock.getBoundingClientRect();
            const gapProgress = (clientY - previousRect.bottom) / Math.max(1, rect.top - previousRect.bottom);
            if (gapProgress > 0.55) {
                return resolvePointerBlockTarget(
                    block,
                    null,
                    clientX,
                    clampPointerYToBlock(block, clientY),
                    0,
                );
            }

            return resolvePointerBlockTarget(
                previousBlock,
                null,
                clientX,
                clampPointerYToBlock(previousBlock, clientY),
                getBlockText(previousBlock).length,
            );
        }

        previousBlock = block;
    }

    return {
        ...resolvePointerBlockTarget(
            previousBlock,
            null,
            clientX,
            clampPointerYToBlock(previousBlock, clientY),
            getBlockText(previousBlock).length,
        ),
        virtualEof: true,
    };
}

function resolvePointerBlockTarget(
    block: HTMLElement,
    pointerElement: Element | null,
    clientX: number,
    clientY: number,
    offset = getPointerCaretOffset(block, clientX, clientY),
): PointerBlockTarget {
    return {
        block,
        offset,
        ...readPointerBlockSourceTarget(block, clientX, clientY),
        ...readPointerProjectedSourceTarget(block, pointerElement, clientX, clientY),
    };
}

function clampPointerYToBlock(block: HTMLElement, clientY: number): number {
    const rect = getBlockContent(block).getBoundingClientRect();
    return rect.height > 2
        ? clamp(clientY, rect.top + 1, rect.bottom - 1)
        : rect.top + rect.height / 2;
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
    if (target.documentOffset !== undefined) {
        return sourceOffsetToDomPoint(target.documentOffset, {
            revealSource: true,
        });
    }

    return getTextPosition(getBlockContent(target.block), target.offset);
}

function readPointerTargetDocumentOffset(target: PointerBlockTarget): number | null {
    if (target.documentOffset !== undefined) {
        return target.documentOffset;
    }

    const position = getPointerTargetTextPosition(target);
    return position ? domPointToSourceOffset(position.node, position.offset) : null;
}

function extendSourceSelectionToOffset(anchor: number, head: number, focusBlock: HTMLElement): void {
    const state = getEditorState();
    const nextSelection = { anchor, head };
    dispatch({
        changes: [],
        selection: {
            ...nextSelection,
            anchorAffinity: state.selection.anchorAffinity,
            headAffinity: "downstream",
            source: selectionTouchesSource(nextSelection),
        },
        annotations: { userEvent: "programmatic", addToHistory: false },
    });
    hooks.onBlockActivated?.(focusBlock);
    syncDomSelectionFromState({ focus: "editor" });
    setPointerSelecting(anchor !== head);
}

function readPointerBlockSourceTarget(
    block: HTMLElement,
    clientX: number,
    clientY: number,
): Pick<PointerBlockTarget, "documentOffset"> | null {
    const sources = Array.from(
        getBlockContent(block).querySelectorAll<HTMLElement>(".format-block-source"),
    ).filter((source) => source.getAttribute("contenteditable") !== "false");
    if (block.dataset.blockSourceActive !== "true") {
        const source = sources.find((candidate) =>
            isPointInInactiveBlockSourceBand(block, candidate, clientX, clientY));
        if (!source) {
            return null;
        }
        setBlockSourceActive(block, true);
    }

    for (const source of sources) {
        if (!isPointInsideSourceBand(block, source, clientX, clientY)) {
            continue;
        }

        const sourceFrom = Number.parseInt(source.dataset.sourceFrom ?? "", 10);
        const sourceTo = Number.parseInt(source.dataset.sourceTo ?? "", 10);
        if (!Number.isFinite(sourceFrom) || !Number.isFinite(sourceTo)) {
            return null;
        }
        const sourceOffset = readPointerBlockSourceOffset(source, clientX, clientY);
        return {
            documentOffset: clamp(sourceFrom + sourceOffset, sourceFrom, sourceTo),
        };
    }

    return null;
}

function isPointInInactiveBlockSourceBand(
    block: HTMLElement,
    source: HTMLElement,
    clientX: number,
    clientY: number,
): boolean {
    if (readBlockSourcePosition(source) !== "prefix") {
        return false;
    }

    const content = getBlockContent(block);
    const contentRect = content.getBoundingClientRect();
    return (
        clientX < contentRect.left &&
        clientY >= contentRect.top - 2 &&
        clientY <= contentRect.bottom + 2
    );
}

function readPointerBlockSourceOffset(
    source: HTMLElement,
    clientX: number,
    clientY: number,
): number {
    if (source.classList.contains("format-block-source-prefix")) {
        const sourceTextRect = readElementTextRect(source);
        if (sourceTextRect) {
            if (clientX <= sourceTextRect.left) return 0;
            if (clientX >= sourceTextRect.right) return source.textContent?.length ?? 0;
        }
    }

    return readPointerPlainTextOffset(source, clientX, clientY);
}

function readElementTextRect(element: HTMLElement): DOMRect | null {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rect = range.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? rect : null;
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

function readPointerProjectedSourceTarget(
    block: HTMLElement,
    target: Element | null,
    clientX: number,
    clientY: number,
): Pick<PointerBlockTarget, "documentOffset"> | null {
    const token = target?.closest<HTMLElement>(".markdown-token[data-source-raw]") ?? null;
    const tokenRange = token ? readSourceTokenDocumentRange(token) : null;
    if (token && token.closest<HTMLElement>("[data-block]") === block && tokenRange) {
        const previewOffset = readPointerPlainTextOffset(token, clientX, clientY);
        const sourceOffset = readSourceTokenEditOffsetFromPreviewOffset(token, previewOffset);
        return {
            documentOffset: clamp(tokenRange.from + sourceOffset, tokenRange.from, tokenRange.to),
        };
    }

    const preview = target?.closest<HTMLElement>(".format-block-preview") ?? null;
    if (!preview || preview.closest<HTMLElement>("[data-block]") !== block) {
        return null;
    }

    const source = getBlockSourceElement(getBlockContent(block), "atomic");
    const sourceFrom = Number.parseInt(source?.dataset.sourceFrom ?? "", 10);
    const sourceTo = Number.parseInt(source?.dataset.sourceTo ?? "", 10);
    if (!source || !Number.isFinite(sourceFrom) || !Number.isFinite(sourceTo)) {
        return null;
    }

    const rect = preview.getBoundingClientRect();
    return {
        documentOffset: clientX <= rect.left + rect.width / 2 ? sourceFrom : sourceTo,
    };
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
    const leftBoundary = Number.NEGATIVE_INFINITY;
    const rightBoundary = Math.max(contentRect.left, sourceRect.right + 4);
    const verticalSlop = 2;
    const topBoundary = Math.min(contentRect.top, sourceRect.top) - verticalSlop;
    const bottomBoundary = Math.max(contentRect.bottom, sourceRect.bottom) + verticalSlop;

    return (
        clientX >= leftBoundary &&
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
    if (pointerTarget.documentOffset !== undefined) {
        const selection = { anchor: pointerTarget.documentOffset, head: pointerTarget.documentOffset };
        dispatch({
            changes: [],
            selection: {
                ...selection,
                source: selectionTouchesSource(selection),
            },
            annotations: { userEvent: "programmatic", addToHistory: false },
        });
        hooks.onBlockActivated?.(pointerTarget.block);
        syncDomSelectionFromState({ focus: "editor" });
        return;
    }

    focusBlockAtOffset(pointerTarget.block, pointerTarget.offset, { scroll: "minimal" });
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
    scheduleGutterHover(event.clientX, event.clientY);
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

    syncGutterHoverBlock(block);
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

    const surfaceRect = getElement<HTMLElement>("document-surface").getBoundingClientRect();
    const gutterLeft = Math.max(surfaceRect.left, blockRect.left - 48);
    const gutterRight = blockRect.left - 4;
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
