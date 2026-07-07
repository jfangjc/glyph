import {
    findSourceBlockAtOffset,
} from "./block-index";
import {
    dispatch,
    getEditorState,
} from "./store";
import type { SourceBlock } from "./types";
import {
    findBlock,
    getBlockContent,
    getBlockText,
    setBlockText,
} from "../blocks/view";
import {
    findBlockSourceElement,
    getBlockSourceElement,
    getBlockSourceOffset,
    readBlockSourcePosition,
} from "../blocks/rendering";
import {
    findRenderedContentTextPosition,
    getRenderedContentBoundaryOffset,
    stripCaretSpacers,
} from "../selection/rendered-content-dom";
import { getElement } from "../../utils/dom";

type DomPoint = {
    node: Node;
    offset: number;
};

type SourceOffsetToDomPointOptions = {
    activateBlockSource?: boolean;
    activateSourceTokens?: boolean;
};

const markdownTokenEditingClass = "markdown-token-editing";
const nativeSourceNavigationTimeoutMs = 500;

type NativeSourceNavigationDirection = "forward" | "backward";

let pendingNativeSourceNavigation: { direction: NativeSourceNavigationDirection; timestamp: number } | null = null;

export function applySourceBlockProjectionMetadata(blockElement: HTMLElement, block: SourceBlock): void {
    blockElement.dataset.blockId = block.id;
    blockElement.dataset.sourceFrom = String(block.sourceFrom);
    blockElement.dataset.sourceTo = String(block.sourceTo);
    blockElement.dataset.contentFrom = String(block.contentFrom);
    blockElement.dataset.contentTo = String(block.contentTo);

    const content = getBlockContent(blockElement);
    content.dataset.sourceFrom = String(block.contentFrom);
    content.dataset.sourceTo = String(block.contentTo);

    applyPrefixSourceElementRange(getBlockSourceElement(content, "prefix"), block.sourceFrom, block.contentFrom);
    applySourceElementRange(getBlockSourceElement(content, "suffix"), block.sourceTo, "end");
    applySourceElementRange(getBlockSourceElement(content, "atomic"), block.sourceFrom);
}

export function sourceOffsetToDomPoint(offset: number, options: SourceOffsetToDomPointOptions = {}): DomPoint {
    const state = getEditorState();
    const clampedOffset = clampOffset(offset, state.doc.length);
    const sourceBlock = findSourceBlockAtOffset(state.blocks, clampedOffset);
    const blockElement = sourceBlock ? findProjectedBlockElement(sourceBlock.id) : null;
    if (!sourceBlock || !blockElement) {
        return fallbackEditorDomPoint();
    }

    const content = getBlockContent(blockElement);
    const sourcePoint = findSourceElementDomPoint(content, clampedOffset, options.activateBlockSource ?? false);
    if (sourcePoint) {
        return sourcePoint;
    }

    const bodyOffset = clampOffset(clampedOffset - sourceBlock.contentFrom, sourceBlock.contentTo - sourceBlock.contentFrom);
    const sourceTokenPoint = findSourceTokenDomPoint(content, bodyOffset, options.activateSourceTokens ?? false);
    if (sourceTokenPoint) {
        return sourceTokenPoint;
    }

    const bodyPoint = findRenderedContentTextPosition(content, bodyOffset);
    if (bodyPoint) {
        return bodyPoint;
    }

    return {
        node: content,
        offset: content.childNodes.length,
    };
}

export function beginNativeSourceNavigation(direction: NativeSourceNavigationDirection): void {
    pendingNativeSourceNavigation = {
        direction,
        timestamp: Date.now(),
    };
}

export function installNativeSourceNavigationTracker(editor: HTMLElement): void {
    editor.addEventListener("keydown", (event) => {
        const direction = readPlainNativeSourceNavigationDirection(event);
        if (direction) {
            beginNativeSourceNavigation(direction);
            const pending = pendingNativeSourceNavigation;
            window.setTimeout(() => {
                if (pendingNativeSourceNavigation === pending) {
                    syncStateSelectionFromDom();
                }
            }, 0);
        }
    }, { capture: true });
}

export function moveSourceSelectionVertically(direction: "up" | "down"): boolean {
    const state = getEditorState();
    if (state.selection.anchor !== state.selection.head) {
        return false;
    }

    const target = normalizeVerticalSourceNavigationTarget(
        state,
        state.selection.head,
        findVerticalSourceNavigationOffset(state.doc, state.selection.head, direction),
        direction,
    );
    if (target === null) {
        return false;
    }

    dispatch({
        changes: [],
        selection: { anchor: target, head: target },
        annotations: { userEvent: "programmatic", addToHistory: false },
    });
    syncDomSelectionFromState();
    return true;
}

function normalizeVerticalSourceNavigationTarget(
    state: ReturnType<typeof getEditorState>,
    fromOffset: number,
    targetOffset: number | null,
    direction: "up" | "down",
): number | null {
    if (targetOffset === null) {
        return null;
    }

    const fromBlock = findSourceBlockAtOffset(state.blocks, fromOffset);
    if (fromBlock && isPrefixNavigationOffset(fromBlock, fromOffset)) {
        const adjacent = findAdjacentSourceBlock(state.blocks.blocks, fromBlock, direction === "up" ? -1 : 1);
        return adjacent ? adjacent.contentFrom : targetOffset;
    }

    const targetBlock = findSourceBlockAtOffset(state.blocks, targetOffset);
    if (targetBlock && isPrefixNavigationOffset(targetBlock, targetOffset)) {
        return targetBlock.contentFrom;
    }

    return targetOffset;
}

function findAdjacentSourceBlock(blocks: SourceBlock[], block: SourceBlock, delta: -1 | 1): SourceBlock | null {
    const index = blocks.findIndex((candidate) => candidate.id === block.id);
    return index < 0 ? null : blocks[index + delta] ?? null;
}

function isPrefixNavigationOffset(block: SourceBlock, offset: number): boolean {
    return offset >= block.sourceFrom && offset < block.contentFrom && canNavigatePastSourcePrefix(block);
}

function canNavigatePastSourcePrefix(block: SourceBlock): boolean {
    return (
        block.type === "list" ||
        block.type === "ordered-list" ||
        block.type === "todo" ||
        block.type === "quote" ||
        block.type.startsWith("heading-")
    );
}

// Projection-only DOM reader: translates a browser DOM point to a canonical
// EditorState.doc UTF-16 offset. It must not be used to recover source text.
export function domPointToSourceOffset(node: Node, offset: number): number {
    const state = getEditorState();
    const source = findBlockSourceElement(node);
    if (source) {
        const sourceFrom = readDatasetNumber(source.dataset.sourceFrom);
        const sourceTo = readDatasetNumber(source.dataset.sourceTo);
        if (sourceFrom !== null && sourceTo !== null) {
            const sourceOffset = readBlockSourceOffset(source, node, offset);
            return clampOffset(sourceFrom + sourceOffset, sourceTo);
        }
    }

    const block = findBlock(node);
    if (!block) {
        return clampOffset(state.selection.head, state.doc.length);
    }

    const content = getBlockContent(block);
    const contentFrom = readDatasetNumber(content.dataset.sourceFrom) ?? readDatasetNumber(block.dataset.contentFrom);
    const contentTo = readDatasetNumber(content.dataset.sourceTo) ?? readDatasetNumber(block.dataset.contentTo);
    if (contentFrom === null || contentTo === null) {
        return clampOffset(state.selection.head, state.doc.length);
    }

    if (node === block) {
        return offset <= 0 ? readDatasetNumber(block.dataset.sourceFrom) ?? contentFrom : readDatasetNumber(block.dataset.sourceTo) ?? contentTo;
    }

    const inactiveSourceTokenOffset = content === node || content.contains(node)
        ? readInactiveSourceTokenOffset(content, node, offset)
        : null;
    if (inactiveSourceTokenOffset !== null) {
        return clampOffset(contentFrom + inactiveSourceTokenOffset, contentTo);
    }

    const localOffset = content === node || content.contains(node)
        ? getRenderedContentBoundaryOffset(content, node, offset)
        : readBlockEdgeOffset(block, node, offset);

    return clampOffset(contentFrom + localOffset, contentTo);
}

export function syncDomSelectionFromState(): void {
    const state = getEditorState();
    const selection = document.getSelection();
    if (!selection) {
        return;
    }

    const activateSourceTokens = state.selection.anchor === state.selection.head;
    const anchor = sourceOffsetToDomPoint(state.selection.anchor, {
        activateBlockSource: true,
        activateSourceTokens,
    });
    const head = sourceOffsetToDomPoint(state.selection.head, {
        activateBlockSource: true,
        activateSourceTokens,
    });
    const editor = getElement<HTMLElement>("editor");
    const range = document.createRange();

    editor.focus({ preventScroll: true });
    range.setStart(anchor.node, anchor.offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    if (state.selection.anchor !== state.selection.head) {
        selection.extend(head.node, head.offset);
    }

    clearActiveSourceTokensOutsideSelection();
    syncListBlockSourceActivationFromState(state);
}

export function syncStateSelectionFromDom(): boolean {
    const selection = document.getSelection();
    if (!selection?.anchorNode || !selection.focusNode) {
        return false;
    }

    const state = getEditorState();
    const nextSelection = {
        anchor: domPointToSourceOffset(selection.anchorNode, selection.anchorOffset),
        head: domPointToSourceOffset(selection.focusNode, selection.focusOffset),
    };
    const navigationDirection = consumeNativeSourceNavigation();
    const nativeStepSelection = readNativeSourceNavigationStep(state, nextSelection, navigationDirection);
    if (nativeStepSelection) {
        dispatch({
            changes: [],
            selection: nativeStepSelection,
            annotations: { userEvent: "programmatic", addToHistory: false },
        });
        syncDomSelectionFromState();
        return true;
    }

    const inactiveTokenSelection = readInactiveSourceTokenSelection(selection, nextSelection);
    if (inactiveTokenSelection) {
        dispatch({
            changes: [],
            selection: inactiveTokenSelection,
            annotations: { userEvent: "programmatic", addToHistory: false },
        });
        syncDomSelectionFromState();
        return true;
    }

    const skippedTokenSelection = readSkippedSourceTokenSelection(selection, state, nextSelection);
    if (skippedTokenSelection) {
        dispatch({
            changes: [],
            selection: skippedTokenSelection,
            annotations: { userEvent: "programmatic", addToHistory: false },
        });
        syncDomSelectionFromState();
        return true;
    }

    if (nextSelection.anchor === state.selection.anchor && nextSelection.head === state.selection.head) {
        return false;
    }

    dispatch({
        changes: [],
        selection: nextSelection,
        annotations: { userEvent: "programmatic", addToHistory: false },
    });
    return false;
}

function consumeNativeSourceNavigation(): NativeSourceNavigationDirection | null {
    const pending = pendingNativeSourceNavigation;
    pendingNativeSourceNavigation = null;
    if (!pending || Date.now() - pending.timestamp > nativeSourceNavigationTimeoutMs) {
        return null;
    }

    return pending.direction;
}

function readPlainNativeSourceNavigationDirection(event: KeyboardEvent): NativeSourceNavigationDirection | null {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return null;
    }

    if (event.key === "ArrowRight") {
        return "forward";
    }

    if (event.key === "ArrowLeft") {
        return "backward";
    }

    return null;
}

function findVerticalSourceNavigationOffset(doc: string, offset: number, direction: "up" | "down"): number | null {
    const line = readSourceLineAtOffset(doc, offset);
    const column = offset - line.from;

    if (direction === "up") {
        if (line.from === 0) {
            return null;
        }

        const previousLine = readSourceLineEndingAtOffset(doc, line.from - 1);
        return previousLine.from + Math.min(column, previousLine.to - previousLine.from);
    }

    if (line.to >= doc.length) {
        return null;
    }

    const nextLine = readSourceLineAtOffset(doc, line.to + 1);
    return nextLine.from + Math.min(column, nextLine.to - nextLine.from);
}

function readSourceLineAtOffset(doc: string, offset: number): { from: number; to: number } {
    const clampedOffset = clampOffset(offset, doc.length);
    const from = doc.lastIndexOf("\n", Math.max(0, clampedOffset - 1)) + 1;
    const nextBreak = doc.indexOf("\n", clampedOffset);
    return {
        from,
        to: nextBreak < 0 ? doc.length : nextBreak,
    };
}

function readSourceLineEndingAtOffset(doc: string, offset: number): { from: number; to: number } {
    const to = clampOffset(offset, doc.length);
    const from = doc.lastIndexOf("\n", Math.max(0, to - 1)) + 1;
    return { from, to };
}

function applySourceElementRange(
    source: HTMLElement | null,
    boundaryOffset: number,
    boundary: "start" | "end" = "start",
): void {
    if (!source) {
        return;
    }

    const textLength = source.textContent?.length ?? 0;
    const sourceFrom = boundary === "start" ? boundaryOffset : boundaryOffset - textLength;
    const sourceTo = boundary === "start" ? boundaryOffset + textLength : boundaryOffset;

    source.dataset.sourceFrom = String(sourceFrom);
    source.dataset.sourceTo = String(sourceTo);
    delete source.dataset.sourceHiddenPrefixLength;
}

function applyPrefixSourceElementRange(source: HTMLElement | null, sourceFrom: number, sourceTo: number): void {
    if (!source) {
        return;
    }

    const textLength = source.textContent?.length ?? 0;
    const hiddenPrefixLength = Math.max(0, sourceTo - sourceFrom - textLength);

    source.dataset.sourceFrom = String(sourceFrom);
    source.dataset.sourceTo = String(sourceTo);
    if (hiddenPrefixLength > 0) {
        source.dataset.sourceHiddenPrefixLength = String(hiddenPrefixLength);
    } else {
        delete source.dataset.sourceHiddenPrefixLength;
    }
}

function findProjectedBlockElement(blockId: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-block][data-block-id="${CSS.escape(blockId)}"]`);
}

function findSourceElementDomPoint(content: HTMLElement, offset: number, activateBlockSource: boolean): DomPoint | null {
    for (const source of Array.from(content.querySelectorAll<HTMLElement>(".format-block-source"))) {
        const sourceFrom = readDatasetNumber(source.dataset.sourceFrom);
        const sourceTo = readDatasetNumber(source.dataset.sourceTo);
        if (sourceFrom === null || sourceTo === null || !isOffsetInsideSourceElement(source, offset, sourceFrom, sourceTo)) {
            continue;
        }

        if (activateBlockSource) {
            source.closest<HTMLElement>("[data-block]")?.setAttribute("data-block-source-active", "true");
        }

        return getBlockSourceDomPoint(source, offset - sourceFrom);
    }

    return null;
}

function syncListBlockSourceActivationFromState(state: ReturnType<typeof getEditorState>): void {
    const activeSourceBlock = readActiveListSourceBlock(state);
    const listBlocks = document.querySelectorAll<HTMLElement>(
        "[data-block][data-type='list'], [data-block][data-type='ordered-list'], [data-block][data-type='todo']",
    );

    for (const block of Array.from(listBlocks)) {
        if (activeSourceBlock && block.dataset.blockId === activeSourceBlock.id) {
            block.dataset.blockSourceActive = "true";
        } else {
            delete block.dataset.blockSourceActive;
        }
    }
}

function readActiveListSourceBlock(state: ReturnType<typeof getEditorState>): SourceBlock | null {
    if (state.selection.anchor !== state.selection.head) {
        return null;
    }

    const block = findSourceBlockAtOffset(state.blocks, state.selection.head);
    if (!block || !isListBlock(block)) {
        return null;
    }

    return state.selection.head >= block.sourceFrom && state.selection.head < block.contentFrom ? block : null;
}

function isOffsetInsideSourceElement(source: HTMLElement, offset: number, sourceFrom: number, sourceTo: number): boolean {
    const position = readBlockSourcePosition(source);
    if (position === "prefix") {
        return offset >= sourceFrom && offset < sourceTo;
    }

    if (position === "suffix") {
        return offset > sourceFrom && offset <= sourceTo;
    }

    return offset >= sourceFrom && offset <= sourceTo;
}

function findSourceTokenDomPoint(root: HTMLElement, offset: number, activateSourceTokens: boolean): DomPoint | null {
    let cursor = 0;
    for (const child of Array.from(root.childNodes)) {
        const length = readSourceTokenSearchLength(child);
        const targetIsInChild = offset < cursor + length || isRawSourceTokenBoundary(child, offset - cursor);
        if (!targetIsInChild) {
            cursor += length;
            continue;
        }

        const position = findSourceTokenDomPointInNode(child, offset - cursor, activateSourceTokens);
        if (position !== undefined) {
            return position;
        }

        return null;
    }

    return null;
}

function readInactiveSourceTokenSelection(
    selection: Selection,
    nextSelection: { anchor: number; head: number },
): { anchor: number; head: number } | null {
    if (
        !selection.isCollapsed ||
        nextSelection.anchor !== nextSelection.head ||
        !selection.focusNode ||
        !findInactiveSourceTokenAtDomPoint(selection.focusNode)
    ) {
        return null;
    }

    return nextSelection;
}

function readInactiveSourceTokenOffset(content: HTMLElement, node: Node, offset: number): number | null {
    const token = findInactiveSourceTokenAtDomPoint(node);
    if (!token || !content.contains(token)) {
        return null;
    }

    const rawSource = readRawSourceTokenText(token);
    const tokenRange = rawSource === null ? null : readSourceTokenRange(content, token);
    if (rawSource === null || !tokenRange) {
        return null;
    }

    return tokenRange.from + readInactiveTokenRawOffset(token, rawSource, node, offset);
}

function findInactiveSourceTokenAtDomPoint(node: Node): HTMLElement | null {
    const element = node instanceof Element ? node : node.parentElement;
    const token = element?.closest<HTMLElement>(".markdown-token") ?? null;
    if (!token || token.dataset.active === "true" || readRawSourceTokenText(token) === null) {
        return null;
    }

    return token;
}

function readInactiveTokenRawOffset(token: HTMLElement, rawSource: string, node: Node, offset: number): number {
    if (node === token) {
        if (offset <= 0) {
            return 0;
        }

        if (offset >= token.childNodes.length) {
            return rawSource.length;
        }
    }

    const previewText = readTokenPreviewText(token);
    if (previewText.length === 0) {
        return offset <= 0 ? 0 : rawSource.length;
    }

    const previewOffset = getTokenPreviewBoundaryOffset(token, node, offset);
    const sourcePrefixLength = readTokenPreviewSourcePrefixLength(rawSource, previewText);
    return clampOffset(sourcePrefixLength + previewOffset, rawSource.length);
}

function readTokenPreviewText(token: HTMLElement): string {
    return stripCaretSpacers(token.textContent ?? "");
}

function getTokenPreviewBoundaryOffset(current: Node, anchorNode: Node, anchorOffset: number): number {
    if (current === anchorNode) {
        if (current.nodeType === Node.TEXT_NODE) {
            return stripCaretSpacers((current.textContent ?? "").slice(0, anchorOffset)).length;
        }

        return Array.from(current.childNodes)
            .slice(0, Math.max(0, anchorOffset))
            .reduce((length, child) => length + readTokenPreviewTextFromNode(child), 0);
    }

    let offset = 0;
    for (const child of Array.from(current.childNodes)) {
        if (child === anchorNode || child.contains(anchorNode)) {
            return offset + getTokenPreviewBoundaryOffset(child, anchorNode, anchorOffset);
        }

        offset += readTokenPreviewTextFromNode(child);
    }

    return offset;
}

function readTokenPreviewTextFromNode(node: Node): number {
    return stripCaretSpacers(node.textContent ?? "").length;
}

function readTokenPreviewSourcePrefixLength(rawSource: string, previewText: string): number {
    const exactPreviewIndex = rawSource.indexOf(previewText);
    if (exactPreviewIndex >= 0) {
        return exactPreviewIndex;
    }

    return Math.max(0, Math.floor((rawSource.length - previewText.length) / 2));
}

function readNativeSourceNavigationStep(
    state: ReturnType<typeof getEditorState>,
    nextSelection: { anchor: number; head: number },
    direction: NativeSourceNavigationDirection | null,
): { anchor: number; head: number } | null {
    if (
        !direction ||
        state.selection.anchor !== state.selection.head ||
        nextSelection.anchor !== nextSelection.head
    ) {
        return null;
    }

    const targetOffset = findSourceNavigationStepTarget(state, direction);
    if (targetOffset === null || nextSelection.head === targetOffset) {
        return null;
    }

    return { anchor: targetOffset, head: targetOffset };
}

export function findSourceNavigationStepTarget(
    state: ReturnType<typeof getEditorState>,
    direction: NativeSourceNavigationDirection,
): number | null {
    if (state.selection.anchor !== state.selection.head) {
        return null;
    }

    const previousOffset = state.selection.head;
    const targetOffset = direction === "forward" ? previousOffset + 1 : previousOffset - 1;
    if (targetOffset < 0 || targetOffset > state.doc.length) {
        return null;
    }

    return normalizeHiddenPrefixNavigationTarget(state.blocks.blocks, targetOffset, direction);
}

function normalizeHiddenPrefixNavigationTarget(
    blocks: SourceBlock[],
    targetOffset: number,
    direction: NativeSourceNavigationDirection,
): number {
    const targetBlock = findSourceBlockAtOffset({ blocks }, targetOffset);
    const hiddenPrefix = targetBlock ? readHiddenPrefixRange(targetBlock) : null;
    if (!targetBlock || !hiddenPrefix || targetOffset < hiddenPrefix.from || targetOffset >= hiddenPrefix.to) {
        return targetOffset;
    }

    if (direction === "forward") {
        return hiddenPrefix.to;
    }

    const previousBlock = findAdjacentSourceBlock(blocks, targetBlock, -1);
    return previousBlock?.sourceTo ?? targetBlock.sourceFrom;
}

function readHiddenPrefixRange(block: SourceBlock): { from: number; to: number } | null {
    if (!isListBlock(block)) {
        return null;
    }

    const visiblePrefixLength = readVisibleListPrefixLength(block);
    const hiddenTo = block.contentFrom - visiblePrefixLength;
    if (hiddenTo <= block.sourceFrom) {
        return null;
    }

    return {
        from: block.sourceFrom,
        to: hiddenTo,
    };
}

function isListBlock(block: SourceBlock): boolean {
    return block.type === "list" || block.type === "ordered-list" || block.type === "todo";
}

function readVisibleListPrefixLength(block: SourceBlock): number {
    if (block.type === "ordered-list") {
        return `${block.listNumber ?? "1"}. `.length;
    }

    if (block.type === "todo") {
        return `${block.listMarker ?? "-"} [${block.checked ? "x" : " "}] `.length;
    }

    return `${block.listMarker ?? "-"} `.length;
}

function readSkippedSourceTokenSelection(
    selection: Selection,
    state: ReturnType<typeof getEditorState>,
    nextSelection: { anchor: number; head: number },
): { anchor: number; head: number } | null {
    if (
        !selection.isCollapsed ||
        state.selection.anchor !== state.selection.head ||
        nextSelection.anchor !== nextSelection.head ||
        !selection.focusNode
    ) {
        return null;
    }

    const previousOffset = state.selection.head;
    const nextOffset = nextSelection.head;
    if (previousOffset === nextOffset) {
        return null;
    }

    const direction = nextOffset > previousOffset ? "forward" : "backward";
    const skippedToken = findAdjacentSourceToken(selection.focusNode, selection.focusOffset, direction === "forward" ? "previous" : "next");
    if (!skippedToken || skippedToken.dataset.active === "true") {
        return null;
    }

    const block = findBlock(skippedToken);
    if (!block) {
        return null;
    }

    const content = getBlockContent(block);
    const contentFrom = readDatasetNumber(content.dataset.sourceFrom) ?? readDatasetNumber(block.dataset.contentFrom);
    if (contentFrom === null) {
        return null;
    }

    const tokenRange = readSourceTokenRange(content, skippedToken);
    if (!tokenRange || tokenRange.from === tokenRange.to) {
        return null;
    }

    const sourceFrom = contentFrom + tokenRange.from;
    const sourceTo = contentFrom + tokenRange.to;
    if (direction === "forward" && previousOffset === sourceFrom && nextOffset === sourceTo) {
        const offset = Math.min(sourceTo, sourceFrom + 1);
        return { anchor: offset, head: offset };
    }

    if (direction === "backward" && previousOffset === sourceTo && nextOffset === sourceFrom) {
        const offset = Math.max(sourceFrom, sourceTo - 1);
        return { anchor: offset, head: offset };
    }

    return null;
}

function findAdjacentSourceToken(node: Node, offset: number, direction: "previous" | "next"): HTMLElement | null {
    const boundary = getSelectionBoundary(node, offset, direction);
    if (!boundary) {
        return null;
    }

    let candidate: Node | null =
        direction === "previous"
            ? boundary.parent.childNodes[boundary.offset - 1] ?? null
            : boundary.parent.childNodes[boundary.offset] ?? null;

    while (candidate?.nodeType === Node.TEXT_NODE && stripCaretSpacers(candidate.textContent ?? "") === "") {
        candidate = direction === "previous" ? candidate.previousSibling : candidate.nextSibling;
    }

    return candidate instanceof HTMLElement &&
        candidate.classList.contains("markdown-token") &&
        readRawSourceTokenText(candidate) !== null
        ? candidate
        : null;
}

function getSelectionBoundary(
    node: Node,
    offset: number,
    direction: "previous" | "next",
): { parent: Node; offset: number } | null {
    if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? "";
        const before = stripCaretSpacers(text.slice(0, offset));
        const after = stripCaretSpacers(text.slice(offset));

        if ((direction === "previous" && before !== "") || (direction === "next" && after !== "")) {
            return null;
        }

        const parent = node.parentNode;
        if (!parent) {
            return null;
        }

        const childIndex = Array.from(parent.childNodes).findIndex((child) => child === node);
        return { parent, offset: direction === "previous" ? childIndex : childIndex + 1 };
    }

    return { parent: node, offset };
}

function readSourceTokenRange(root: HTMLElement, token: HTMLElement): { from: number; to: number } | null {
    let cursor = 0;
    for (const child of Array.from(root.childNodes)) {
        const range = readSourceTokenRangeInNode(child, token, cursor);
        if (range) {
            return range;
        }

        cursor += readSourceTokenSearchLength(child);
    }

    return null;
}

function readSourceTokenRangeInNode(node: Node, token: HTMLElement, start: number): { from: number; to: number } | null {
    if (node === token) {
        return {
            from: start,
            to: start + readSourceTokenSearchLength(node),
        };
    }

    if (node instanceof HTMLElement && node.dataset.sourceIgnore === "true") {
        return null;
    }

    let cursor = start;
    for (const child of Array.from(node.childNodes)) {
        const range = readSourceTokenRangeInNode(child, token, cursor);
        if (range) {
            return range;
        }

        cursor += readSourceTokenSearchLength(child);
    }

    return null;
}

function findSourceTokenDomPointInNode(
    node: Node,
    offset: number,
    activateSourceTokens: boolean,
): DomPoint | null | undefined {
    const rawSource = readRawSourceTokenText(node);
    if (rawSource !== null) {
        if (offset >= 0 && offset <= rawSource.length) {
            return readRawSourceTokenDomPoint(node, rawSource, offset, activateSourceTokens);
        }

        return undefined;
    }

    if (node instanceof HTMLElement && node.dataset.sourceIgnore === "true") {
        return undefined;
    }

    if (node.nodeType === Node.TEXT_NODE) {
        return offset < (node.textContent?.length ?? 0) ? null : undefined;
    }

    let cursor = 0;
    for (const child of Array.from(node.childNodes)) {
        const length = readSourceTokenSearchLength(child);
        const targetIsInChild = offset < cursor + length || isRawSourceTokenBoundary(child, offset - cursor);
        if (!targetIsInChild) {
            cursor += length;
            continue;
        }

        const position = findSourceTokenDomPointInNode(child, offset - cursor, activateSourceTokens);
        if (position !== undefined) {
            return position;
        }

        return null;
    }

    return undefined;
}

function readRawSourceTokenDomPoint(
    node: Node,
    rawSource: string,
    offset: number,
    activateSourceTokens: boolean,
): DomPoint | null {
    if (!(node instanceof HTMLElement)) {
        return null;
    }

    if (offset <= 0) {
        return getElementBoundaryDomPoint(node, false);
    }

    if (offset >= rawSource.length) {
        return getElementBoundaryDomPoint(node, true);
    }

    if (!activateSourceTokens || !node.classList.contains("markdown-token")) {
        return null;
    }

    return activateRawSourceTokenAtOffset(node, rawSource, offset);
}

function activateRawSourceTokenAtOffset(token: HTMLElement, rawSource: string, offset: number): DomPoint {
    if (token.dataset.active === "true" && token.classList.contains(markdownTokenEditingClass)) {
        return getPlainTextDomPoint(token, offset);
    }

    token.dataset.sourceBeforeActivation = rawSource;
    token.dataset.active = "true";
    delete token.dataset.sourceRaw;
    token.classList.add(markdownTokenEditingClass);
    token.contentEditable = "true";
    token.spellcheck = false;
    token.replaceChildren(document.createTextNode(rawSource));
    return getPlainTextDomPoint(token, offset);
}

function clearActiveSourceTokensOutsideSelection(): void {
    const selection = document.getSelection();
    const focusBlock = findBlock(selection?.focusNode ?? null);
    const activeBlocks = Array.from(
        new Set(
            Array.from(document.querySelectorAll<HTMLElement>(".markdown-token[data-active='true']"))
                .map((token) => findBlock(token))
                .filter((block): block is HTMLElement => Boolean(block) && block !== focusBlock),
        ),
    );

    for (const block of activeBlocks) {
        if (block.isConnected) {
            setBlockText(block, getBlockText(block));
        }
    }
}

function readRawSourceTokenText(node: Node): string | null {
    if (!(node instanceof HTMLElement)) {
        return null;
    }

    if (node.dataset.sourceRaw !== undefined) {
        return node.dataset.sourceRaw;
    }

    if (node.dataset.active === "true" && node.classList.contains(markdownTokenEditingClass)) {
        return node.textContent ?? "";
    }

    return null;
}

function readSourceTokenSearchLength(node: Node): number {
    const rawSource = readRawSourceTokenText(node);
    if (rawSource !== null) {
        return rawSource.length;
    }

    if (node instanceof HTMLElement && node.dataset.sourceIgnore === "true") {
        return 0;
    }

    if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent?.length ?? 0;
    }

    return Array.from(node.childNodes).reduce((length, child) => length + readSourceTokenSearchLength(child), 0);
}

function isRawSourceTokenBoundary(node: Node, offset: number): boolean {
    const rawSource = readRawSourceTokenText(node);
    return rawSource !== null && offset >= 0 && offset <= rawSource.length;
}

function getElementBoundaryDomPoint(element: HTMLElement, after: boolean): DomPoint {
    const parent = element.parentNode;
    if (!parent) {
        return { node: element, offset: after ? element.childNodes.length : 0 };
    }

    const childIndex = Array.from(parent.childNodes).indexOf(element);
    return {
        node: parent,
        offset: Math.max(0, childIndex) + (after ? 1 : 0),
    };
}

function getBlockSourceDomPoint(source: HTMLElement, sourceOffset: number): DomPoint {
    return getPlainTextDomPoint(source, sourceOffset - readHiddenPrefixLength(source));
}

function readBlockSourceOffset(source: HTMLElement, node: Node, offset: number): number {
    return readHiddenPrefixLength(source) + getBlockSourceOffset(source, node, offset);
}

function readHiddenPrefixLength(source: HTMLElement): number {
    return readDatasetNumber(source.dataset.sourceHiddenPrefixLength) ?? 0;
}

function getPlainTextDomPoint(element: HTMLElement, offset: number): DomPoint {
    const text = element.firstChild ?? element.appendChild(document.createTextNode(""));
    return {
        node: text,
        offset: clampOffset(offset, text.textContent?.length ?? 0),
    };
}

function fallbackEditorDomPoint(): DomPoint {
    const editor = getElement<HTMLElement>("editor");
    return {
        node: editor,
        offset: editor.childNodes.length,
    };
}

function readBlockEdgeOffset(block: HTMLElement, node: Node, offset: number): number {
    const content = getBlockContent(block);
    if (node === block.parentNode) {
        const blockIndex = Array.from(node.childNodes).indexOf(block);
        return offset <= blockIndex ? 0 : content.textContent?.length ?? 0;
    }

    return content.textContent?.length ?? 0;
}

function readDatasetNumber(value: string | undefined): number | null {
    if (value === undefined) {
        return null;
    }

    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function clampOffset(offset: number, docLength: number): number {
    return Math.max(0, Math.min(Math.trunc(offset), docLength));
}
