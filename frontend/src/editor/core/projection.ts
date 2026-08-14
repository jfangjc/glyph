import {
    findSourceBlockAtOffset,
    readVisibleListPrefixLength,
    type SourceAffinity,
    type SourceBlock,
} from "./types";
import {
    dispatch,
    getEditorState,
} from "./store";
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
    getRenderedContentText,
    stripCaretSpacers,
} from "../selection/rendered-content-dom";
import { getElement } from "../../utils/dom";
import { nextGraphemeBoundary, previousGraphemeBoundary } from "../../utils/text-boundaries";
import type { ProjectionCapability } from "./types";

type DomPoint = {
    node: Node;
    offset: number;
};

type DomSelectionSnapshot = {
    anchorNode: Node | null;
    anchorOffset: number;
    focusNode: Node | null;
    focusOffset: number;
};

let projectedDomSelection: DomSelectionSnapshot | null = null;

type SourceOffsetToDomPointOptions = {
    activateBlockSource?: boolean;
    activateSourceTokens?: boolean;
    affinity?: SourceAffinity;
};

const markdownTokenEditingClass = "markdown-token-editing";
const nativeSourceNavigationTimeoutMs = 500;

type NativeSourceNavigationDirection = "forward" | "backward";

let pendingNativeSourceNavigation: { direction: NativeSourceNavigationDirection; timestamp: number } | null = null;
let verticalNavigationAffinity: { preferredColumn: number; revision: number } | null = null;
let activeProjectionCapability: ProjectionCapability | undefined;
let pinnedSourceRevealRange: { from: number; to: number } | null = null;

export function configureProjectionCapability(capability: ProjectionCapability | undefined): void {
    activeProjectionCapability = capability;
}

export function applySourceBlockProjectionMetadata(
    blockElement: HTMLElement,
    block: SourceBlock,
    documentSource: string,
): void {
    blockElement.dataset.blockId = block.id;
    blockElement.dataset.sourceFrom = String(block.sourceFrom);
    blockElement.dataset.sourceTo = String(block.sourceTo);
    blockElement.dataset.contentFrom = String(block.contentFrom);
    blockElement.dataset.contentTo = String(block.contentTo);

    const content = getBlockContent(blockElement);
    content.dataset.sourceFrom = String(block.contentFrom);
    content.dataset.sourceTo = String(block.contentTo);

    if (block.type === "code") {
        const prefix = getBlockSourceElement(content, "prefix");
        const suffix = getBlockSourceElement(content, "suffix");
        if (prefix) {
            updateSourceElementText(
                prefix,
                documentSource.slice(block.sourceFrom, block.contentFrom).replace(/\r?\n$/, ""),
            );
        }
        if (suffix) {
            updateSourceElementText(
                suffix,
                documentSource.slice(block.contentTo, block.sourceTo).replace(/^\r?\n/, ""),
            );
        }

        applySourceElementRange(prefix, block.sourceFrom);
        applySourceElementRange(suffix, block.sourceTo, "end");
        applySourceElementRange(getBlockSourceElement(content, "atomic"), block.sourceFrom);
        return;
    }

    applyPrefixSourceElementRange(getBlockSourceElement(content, "prefix"), block.sourceFrom, block.contentFrom);
    applySourceElementRange(getBlockSourceElement(content, "suffix"), block.sourceTo, "end");
    applySourceElementRange(getBlockSourceElement(content, "atomic"), block.sourceFrom);
}

export function sourceOffsetToDomPoint(offset: number, options: SourceOffsetToDomPointOptions = {}): DomPoint {
    const custom = activeProjectionCapability?.sourceOffsetToDomPoint?.(offset);
    if (custom) {
        return custom;
    }
    const state = getEditorState();
    const clampedOffset = clampOffset(offset, state.doc.length);
    const sourceBlock = findSourceBlockAtOffset(state.blocks, clampedOffset, options.affinity);
    const blockElement = sourceBlock ? findProjectedBlockElement(sourceBlock.id) : null;
    if (!sourceBlock || !blockElement) {
        return fallbackEditorDomPoint();
    }

    applySourceBlockProjectionMetadata(blockElement, sourceBlock, state.doc);

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

export function moveSourceSelectionVertically(
    direction: "up" | "down",
    options: { extend?: boolean } = {},
): boolean {
    const state = getEditorState();
    if (state.selection.anchor !== state.selection.head && !options.extend) {
        resetVerticalNavigationAffinity();
        return false;
    }

    if (verticalNavigationAffinity?.revision !== state.revision) {
        verticalNavigationAffinity = null;
    }

    const currentLine = readSourceLineAtOffset(state.doc, state.selection.head);
    const targetLine = readAdjacentSourceLine(state.doc, currentLine, direction);
    if (!targetLine) {
        resetVerticalNavigationAffinity();
        return false;
    }

    const preferredColumn = verticalNavigationAffinity?.preferredColumn
        ?? readNavigationColumn(state, currentLine, state.selection.head);
    const target = readVerticalNavigationTarget(state, currentLine, targetLine, preferredColumn, direction);
    if (target === null) {
        resetVerticalNavigationAffinity();
        return false;
    }

    dispatch({
        changes: [],
        selection: {
            anchor: options.extend ? state.selection.anchor : target,
            head: target,
        },
        annotations: { userEvent: "programmatic", addToHistory: false },
    });
    verticalNavigationAffinity = {
        preferredColumn,
        revision: getEditorState().revision,
    };
    syncDomSelectionFromState();
    return true;
}

export function resetVerticalNavigationAffinity(): void {
    verticalNavigationAffinity = null;
}

function findAdjacentSourceBlock(blocks: SourceBlock[], block: SourceBlock, delta: -1 | 1): SourceBlock | null {
    const index = blocks.findIndex((candidate) => candidate.id === block.id);
    return index < 0 ? null : blocks[index + delta] ?? null;
}

function readNavigationColumn(
    state: ReturnType<typeof getEditorState>,
    line: { from: number; to: number },
    offset: number,
): number {
    const block = findSourceBlockAtOffset(state.blocks, offset);
    const base = block && usesContentNavigationColumn(block, line)
        ? Math.max(line.from, block.contentFrom)
        : line.from;
    return Math.max(0, offset - base);
}

function readVerticalNavigationTarget(
    state: ReturnType<typeof getEditorState>,
    currentLine: { from: number; to: number },
    targetLine: { from: number; to: number },
    preferredColumn: number,
    direction: "up" | "down",
): number | null {
    const currentBlock = findSourceBlockAtOffset(state.blocks, currentLine.from);
    const targetBlock = findSourceBlockAtOffset(state.blocks, targetLine.from);
    if (
        direction === "up" &&
        targetBlock?.type === "code" &&
        currentBlock?.id !== targetBlock.id &&
        targetLine.to === targetBlock.sourceTo
    ) {
        return targetBlock.sourceTo;
    }

    const base = targetBlock && usesContentNavigationColumn(targetBlock, targetLine)
        ? Math.max(targetLine.from, targetBlock.contentFrom)
        : targetLine.from;
    return Math.min(targetLine.to, base + preferredColumn);
}

function usesContentNavigationColumn(block: SourceBlock, line: { from: number; to: number }): boolean {
    if (line.from !== block.sourceFrom) {
        return false;
    }

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
    const custom = activeProjectionCapability?.domPointToSourceOffset?.(node, offset);
    if (custom !== null && custom !== undefined) {
        return custom;
    }
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

    const sourceBlock = state.blocks.blocks.find((candidate) => candidate.id === block.dataset.blockId);
    if (sourceBlock) {
        applySourceBlockProjectionMetadata(block, sourceBlock, state.doc);
    }

    const content = getBlockContent(block);
    const contentFrom = sourceBlock?.contentFrom ?? readDatasetNumber(content.dataset.sourceFrom) ?? readDatasetNumber(block.dataset.contentFrom);
    const contentTo = sourceBlock?.contentTo ?? readDatasetNumber(content.dataset.sourceTo) ?? readDatasetNumber(block.dataset.contentTo);
    if (contentFrom === null || contentTo === null) {
        return clampOffset(state.selection.head, state.doc.length);
    }

    if (node === block) {
        return offset <= 0 ? readDatasetNumber(block.dataset.sourceFrom) ?? contentFrom : readDatasetNumber(block.dataset.sourceTo) ?? contentTo;
    }

    const atomicBoundaryOffset = sourceBlock
        ? readAtomicBlockContentBoundaryOffset(block, content, sourceBlock, node, offset)
        : null;
    if (atomicBoundaryOffset !== null) {
        return atomicBoundaryOffset;
    }

    const inactiveSourceTokenOffset = content === node || content.contains(node)
        ? readInactiveSourceTokenOffset(content, node, offset)
        : null;
    const activeSourceTokenOffset = content === node || content.contains(node)
        ? readActiveSourceTokenOffset(content, node, offset)
        : null;
    if (activeSourceTokenOffset !== null) {
        return clampOffset(contentFrom + activeSourceTokenOffset, contentTo);
    }
    if (inactiveSourceTokenOffset !== null) {
        return clampOffset(contentFrom + inactiveSourceTokenOffset, contentTo);
    }

    const localOffset = content === node || content.contains(node)
        ? getRenderedContentBoundaryOffset(content, node, offset)
        : readBlockEdgeOffset(block, node, offset);

    return clampOffset(contentFrom + localOffset, contentTo);
}

export function syncDomSelectionFromState(
    options: { focus?: "preserve" | "editor" } = { focus: "editor" },
): void {
    const state = getEditorState();
    const selection = document.getSelection();
    if (!selection) {
        return;
    }

    const focusOwner = options.focus === "preserve" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    reconcileActiveSourceTokensFromState(state);
    if (state.selection.anchor !== state.selection.head) {
        revealSourceTokensInRange(
            Math.min(state.selection.anchor, state.selection.head),
            Math.max(state.selection.anchor, state.selection.head),
        );
    }

    const displaySelection = activeProjectionCapability?.resolveSelectionRange?.(state)
        ?? expandSelectionToSourceTokenBoundaries(state.selection);
    const forward = state.selection.anchor <= state.selection.head;
    const displayAnchor = forward ? displaySelection.from : displaySelection.to;
    const displayHead = forward ? displaySelection.to : displaySelection.from;

    const anchor = sourceOffsetToDomPoint(displayAnchor, {
        activateBlockSource: true,
        activateSourceTokens: true,
        affinity: state.selection.anchorAffinity,
    });
    const head = sourceOffsetToDomPoint(displayHead, {
        activateBlockSource: true,
        activateSourceTokens: true,
        affinity: state.selection.headAffinity,
    });
    const editor = getElement<HTMLElement>("editor");
    const range = document.createRange();

    if (options.focus !== "preserve") {
        editor.focus({ preventScroll: true });
    }
    range.setStart(anchor.node, anchor.offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    if (state.selection.anchor !== state.selection.head) {
        selection.extend(head.node, head.offset);
    }

    clearActiveSourceTokensOutsideSelection();
    syncListBlockSourceActivationFromState(state);
    syncCodeBlockSourceActivationFromState(state);
    projectedDomSelection = readDomSelectionSnapshot(selection);

    if (focusOwner && focusOwner !== editor && focusOwner.isConnected) {
        focusOwner.focus({ preventScroll: true });
    }
}

function expandSelectionToSourceTokenBoundaries(
    selection: ReturnType<typeof getEditorState>["selection"],
): { from: number; to: number } {
    const range = {
        from: Math.min(selection.anchor, selection.head),
        to: Math.max(selection.anchor, selection.head),
    };
    if (range.from === range.to) return range;

    const expanded = { ...range };
    for (const token of Array.from(document.querySelectorAll<HTMLElement>(".markdown-token"))) {
        const tokenRange = readSourceTokenDocumentRange(token);
        const contentRange = readTokenContentRange(token);
        if (!tokenRange || !contentRange) continue;
        const contentFrom = tokenRange.from + contentRange.from;
        const contentTo = tokenRange.from + contentRange.to;
        if (range.from === contentFrom && range.to >= contentTo) {
            expanded.from = Math.min(expanded.from, tokenRange.from);
        }
        if (range.to === contentTo && range.from <= contentFrom) {
            expanded.to = Math.max(expanded.to, tokenRange.to);
        }
    }
    return expanded;
}

export function syncStateSelectionFromDom(): boolean {
    const selection = document.getSelection();
    if (!selection?.anchorNode || !selection.focusNode) {
        return false;
    }

    if (projectedDomSelection && domSelectionMatchesSnapshot(selection, projectedDomSelection)) {
        return false;
    }
    projectedDomSelection = null;

    const state = getEditorState();
    const nextSelection = {
        anchor: selectionBoundaryToSourceOffset(selection, "anchor"),
        head: selectionBoundaryToSourceOffset(selection, "focus"),
        anchorAffinity: readDomBoundaryAffinity(selection.anchorNode, selection.anchorOffset),
        headAffinity: readDomBoundaryAffinity(selection.focusNode, selection.focusOffset),
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

    if (
        nextSelection.anchor === state.selection.anchor &&
        nextSelection.head === state.selection.head &&
        nextSelection.anchorAffinity === state.selection.anchorAffinity &&
        nextSelection.headAffinity === state.selection.headAffinity
    ) {
        return false;
    }

    dispatch({
        changes: [],
        selection: nextSelection,
        annotations: { userEvent: "programmatic", addToHistory: false },
    });
    return false;
}

function updateSourceElementText(source: HTMLElement, value: string): void {
    if (source.textContent === value) {
        return;
    }
    if (source.childNodes.length === 1 && source.firstChild instanceof Text) {
        source.firstChild.data = value;
        return;
    }
    source.replaceChildren(document.createTextNode(value));
}

function readDomBoundaryAffinity(node: Node, offset: number): SourceAffinity {
    if (node instanceof Element) {
        if (offset <= 0) {
            return "downstream";
        }
        if (offset >= node.childNodes.length) {
            return "upstream";
        }
    }

    if (node.nodeType === Node.TEXT_NODE) {
        const length = node.textContent?.length ?? 0;
        return offset >= length ? "upstream" : "downstream";
    }

    return "downstream";
}

function readDomSelectionSnapshot(selection: Selection): DomSelectionSnapshot {
    return {
        anchorNode: selection.anchorNode,
        anchorOffset: selection.anchorOffset,
        focusNode: selection.focusNode,
        focusOffset: selection.focusOffset,
    };
}

function domSelectionMatchesSnapshot(selection: Selection, snapshot: DomSelectionSnapshot): boolean {
    return (
        selection.anchorNode === snapshot.anchorNode &&
        selection.anchorOffset === snapshot.anchorOffset &&
        selection.focusNode === snapshot.focusNode &&
        selection.focusOffset === snapshot.focusOffset
    );
}

function reconcileActiveSourceTokensFromState(state: ReturnType<typeof getEditorState>): void {
    const collapsed = state.selection.anchor === state.selection.head;
    const selectionFrom = Math.min(state.selection.anchor, state.selection.head);
    const selectionTo = Math.max(state.selection.anchor, state.selection.head);
    const activeTokens = Array.from(document.querySelectorAll<HTMLElement>(".markdown-token[data-active='true']"));
    const blocksToRender = new Set<HTMLElement>();

    for (const token of activeTokens) {
        const block = findBlock(token);
        if (!block) {
            continue;
        }
        const tokenRange = readSourceTokenDocumentRange(token);
        const tokenFrom = tokenRange?.from ?? null;
        const tokenTo = tokenRange?.to ?? null;
        const selectionInsideToken = Boolean(
            tokenFrom !== null &&
            tokenTo !== null &&
            (collapsed
                ? state.selection.head > tokenFrom && state.selection.head < tokenTo
                : selectionFrom < tokenTo && selectionTo > tokenFrom) ||
            token.dataset.sourcePinned === "true" ||
            tokenFrom !== null && tokenTo !== null && doesRangeIntersectPinnedSource(tokenFrom, tokenTo),
        );
        if (!selectionInsideToken) {
            blocksToRender.add(block);
        }
    }

    for (const block of blocksToRender) {
        const sourceBlock = state.blocks.blocks.find((candidate) => candidate.id === block.dataset.blockId);
        if (sourceBlock) {
            setBlockText(block, state.doc.slice(sourceBlock.contentFrom, sourceBlock.contentTo));
        }
    }
}

export function syncInlineSourceRevealFromDomSelection(): boolean {
    const blocks = readActiveSourceTokenBlocksOutsideDomSelection();
    if (!rerenderActiveSourceTokenBlocks(blocks)) {
        return false;
    }

    syncDomSelectionFromState();
    return true;
}

export function syncInlineSourceRevealFromSelection(): boolean {
    const state = getEditorState();
    if (state.selection.anchor === state.selection.head) {
        return syncInlineSourceRevealFromDomSelection();
    }

    const selectionFrom = Math.min(state.selection.anchor, state.selection.head);
    const selectionTo = Math.max(state.selection.anchor, state.selection.head);
    const changed = revealSourceTokensInRange(selectionFrom, selectionTo);
    if (changed) syncDomSelectionFromState();
    return changed;
}

export function revealSourceTokensInRange(selectionFrom: number, selectionTo: number): boolean {
    const blocksToRender = new Set<HTMLElement>();
    for (const token of Array.from(document.querySelectorAll<HTMLElement>(".markdown-token[data-active='true']"))) {
        const tokenRange = readSourceTokenDocumentRange(token);
        if (
            !tokenRange ||
            selectionFrom >= tokenRange.to || selectionTo <= tokenRange.from
        ) {
            if (tokenRange && doesRangeIntersectPinnedSource(tokenRange.from, tokenRange.to)) continue;
            const block = findBlock(token);
            if (block) blocksToRender.add(block);
        }
    }

    let changed = rerenderActiveSourceTokenBlocks(Array.from(blocksToRender));
    const sourceTokens = Array.from(
        document.querySelectorAll<HTMLElement>(".markdown-token[data-source-raw]"),
    );
    for (const token of sourceTokens) {
        const tokenRange = readSourceTokenDocumentRange(token);
        if (
            token.isConnected &&
            tokenRange &&
            selectionFrom < tokenRange.to &&
            selectionTo > tokenRange.from &&
            !hasNestedSourceTokenContainingSelection(token, selectionFrom, selectionTo) &&
            activateSourceToken(token)
        ) {
            changed = true;
        }
    }

    return changed;
}

function hasNestedSourceTokenContainingSelection(
    token: HTMLElement,
    selectionFrom: number,
    selectionTo: number,
): boolean {
    for (const nested of Array.from(token.querySelectorAll<HTMLElement>(".markdown-token"))) {
        const nestedRange = readSourceTokenDocumentRange(nested);
        if (nestedRange && selectionFrom >= nestedRange.from && selectionTo <= nestedRange.to) {
            return true;
        }
    }
    return false;
}

export function setPinnedSourceRevealRange(range: { from: number; to: number } | null): void {
    for (const token of Array.from(document.querySelectorAll<HTMLElement>(".markdown-token[data-source-pinned='true']"))) {
        delete token.dataset.sourcePinned;
    }
    pinnedSourceRevealRange = range;
    if (range) {
        revealSourceTokensInRange(range.from, range.to);
        for (const token of Array.from(document.querySelectorAll<HTMLElement>(".markdown-token[data-active='true']"))) {
            const tokenRange = readSourceTokenDocumentRange(token);
            if (tokenRange && range.from < tokenRange.to && range.to > tokenRange.from) {
                token.dataset.sourcePinned = "true";
            }
        }
    } else {
        reconcileActiveSourceTokensFromState(getEditorState());
    }
}

function doesRangeIntersectPinnedSource(from: number, to: number): boolean {
    return Boolean(pinnedSourceRevealRange && pinnedSourceRevealRange.from < to && pinnedSourceRevealRange.to > from);
}

export function clearInlineSourceReveal(): void {
    rerenderActiveSourceTokenBlocks(readAllActiveSourceTokenBlocks());
}

function selectionBoundaryToSourceOffset(selection: Selection, boundary: "anchor" | "focus"): number {
    const node = boundary === "anchor" ? selection.anchorNode : selection.focusNode;
    const offset = boundary === "anchor" ? selection.anchorOffset : selection.focusOffset;
    if (!node) {
        return clampOffset(getEditorState().selection.head, getEditorState().doc.length);
    }

    if (!selection.isCollapsed) {
        const selectedTokenOffset = readSelectedSourceTokenBoundaryOffset(selection, node, offset);
        if (selectedTokenOffset !== null) {
            return selectedTokenOffset;
        }
    }

    return domPointToSourceOffset(node, offset);
}

function readSelectedSourceTokenBoundaryOffset(selection: Selection, node: Node, offset: number): number | null {
    const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    const block = findBlock(node);
    if (!range || !block) {
        return null;
    }

    const boundaryElement = node instanceof Element ? node : node.parentElement;
    if (boundaryElement?.closest(".markdown-token")) {
        return null;
    }

    const content = getBlockContent(block);
    const previousToken = findAdjacentSelectedSourceToken(node, offset, "previous", range);
    if (previousToken && content.contains(previousToken)) {
        return readSourceTokenPreviewBoundaryOffset(content, previousToken, "end");
    }

    const nextToken = findAdjacentSelectedSourceToken(node, offset, "next", range);
    if (nextToken && content.contains(nextToken)) {
        return readSourceTokenPreviewBoundaryOffset(content, nextToken, "start");
    }

    return null;
}

function findAdjacentSelectedSourceToken(
    node: Node,
    offset: number,
    direction: "previous" | "next",
    range: Range,
): HTMLElement | null {
    const token = findAdjacentSourceToken(node, offset, direction);
    if (!token || token.dataset.active === "true" || readRawSourceTokenText(token) === null) {
        return null;
    }

    try {
        return range.intersectsNode(token) ? token : null;
    } catch {
        return null;
    }
}

function readSourceTokenPreviewBoundaryOffset(
    content: HTMLElement,
    token: HTMLElement,
    edge: "start" | "end",
): number | null {
    const contentFrom = readDatasetNumber(content.dataset.sourceFrom);
    const tokenRange = readSourceTokenRange(content, token);
    if (contentFrom === null || !tokenRange) {
        return null;
    }

    const tokenOffset = edge === "start" ? tokenRange.from : tokenRange.to;
    return clampOffset(contentFrom + tokenOffset, getEditorState().doc.length);
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

function readAdjacentSourceLine(
    doc: string,
    line: { from: number; to: number },
    direction: "up" | "down",
): { from: number; to: number } | null {
    if (direction === "up") {
        if (line.from === 0) {
            return null;
        }

        return readSourceLineEndingAtOffset(doc, line.from - 1);
    }

    if (line.to >= doc.length) {
        return null;
    }

    return readSourceLineAtOffset(doc, line.to + 1);
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
            return getBlockSourceDomPoint(source, offset - sourceFrom);
        }

        return getInactiveBlockSourceDomPoint(content, source, offset, sourceFrom, sourceTo);
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

function getInactiveBlockSourceDomPoint(
    content: HTMLElement,
    source: HTMLElement,
    offset: number,
    sourceFrom: number,
    sourceTo: number,
): DomPoint {
    const position = readBlockSourcePosition(source);
    if (position === "prefix") {
        return findRenderedContentTextPosition(content, 0) ?? { node: content, offset: 0 };
    }

    if (position === "suffix") {
        return findRenderedContentTextPosition(content, getRenderedContentText(content).length)
            ?? { node: content, offset: content.childNodes.length };
    }

    const preview = content.querySelector<HTMLElement>(".format-block-preview");
    if (preview) {
        const midpoint = sourceFrom + (sourceTo - sourceFrom) / 2;
        return getElementBoundaryDomPoint(preview, offset >= midpoint);
    }

    return offset <= sourceFrom
        ? { node: content, offset: 0 }
        : { node: content, offset: content.childNodes.length };
}

function syncCodeBlockSourceActivationFromState(state: ReturnType<typeof getEditorState>): void {
    const selectionIsCollapsed = state.selection.anchor === state.selection.head;
    const codeBlocks = document.querySelectorAll<HTMLElement>("[data-block][data-type='code']");

    for (const block of Array.from(codeBlocks)) {
        const sourceBlock = state.blocks.blocks.find((candidate) => candidate.id === block.dataset.blockId);
        const selectionTouchesBlock = Boolean(
            selectionIsCollapsed &&
            sourceBlock &&
            state.selection.head >= sourceBlock.sourceFrom &&
            state.selection.head <= sourceBlock.sourceTo,
        );

        if (selectionTouchesBlock) {
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
    const isCodeSource = source.closest<HTMLElement>("[data-block]")?.dataset.type === "code";
    if (position === "prefix") {
        return offset >= sourceFrom && (isCodeSource ? offset <= sourceTo : offset < sourceTo);
    }

    if (position === "suffix") {
        return (isCodeSource ? offset >= sourceFrom : offset > sourceFrom) && offset <= sourceTo;
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
    const contentFrom = readDatasetNumber(content.dataset.sourceFrom);
    const documentRange = rawSource === null ? null : readSourceTokenDocumentRange(token);
    const tokenRange = contentFrom === null || !documentRange
        ? null
        : { from: documentRange.from - contentFrom, to: documentRange.to - contentFrom };
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

function readActiveSourceTokenOffset(content: HTMLElement, node: Node, offset: number): number | null {
    const element = node instanceof Element ? node : node.parentElement;
    const token = element?.closest<HTMLElement>(".markdown-token[data-active='true']") ?? null;
    const contentFrom = readDatasetNumber(content.dataset.sourceFrom);
    const tokenRange = token ? readSourceTokenDocumentRange(token) : null;
    if (!token || contentFrom === null || !tokenRange) {
        return null;
    }

    return tokenRange.from - contentFrom + getTokenPreviewBoundaryOffset(token, node, offset);
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
    const contentRange = readTokenContentRange(token);
    if (!contentRange || previewText.length === 0) {
        return offset <= 0 ? 0 : rawSource.length;
    }

    const previewOffset = getNestedSourceBoundaryOffset(token, node, offset);
    return clampOffset(contentRange.from + previewOffset, contentRange.to);
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

function readTokenContentRange(token: HTMLElement): { from: number; to: number } | null {
    const from = readDatasetNumber(token.dataset.sourceContentFrom);
    const to = readDatasetNumber(token.dataset.sourceContentTo);
    return from === null || to === null ? null : { from, to };
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
    const targetOffset = direction === "forward"
        ? nextGraphemeBoundary(state.doc, previousOffset)
        : previousGraphemeBoundary(state.doc, previousOffset);
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
        if (node instanceof HTMLElement && node.dataset.active !== "true") {
            const nested = findActiveNestedSourceTokenAtOffset(node, offset);
            if (nested) {
                return findSourceTokenDomPointInNode(
                    nested.token,
                    offset - nested.from,
                    activateSourceTokens,
                );
            }
        }
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

function getNestedSourceBoundaryOffset(current: Node, anchorNode: Node, anchorOffset: number): number {
    if (current === anchorNode) {
        if (current.nodeType === Node.TEXT_NODE) {
            return stripCaretSpacers((current.textContent ?? "").slice(0, anchorOffset)).length;
        }

        return Array.from(current.childNodes)
            .slice(0, Math.max(0, anchorOffset))
            .reduce((length, child) => length + readNestedSourceSearchLength(child), 0);
    }

    let sourceOffset = 0;
    for (const child of Array.from(current.childNodes)) {
        if (child === anchorNode || child.contains(anchorNode)) {
            return sourceOffset + getNestedSourceBoundaryOffset(child, anchorNode, anchorOffset);
        }
        sourceOffset += readNestedSourceSearchLength(child);
    }
    return sourceOffset;
}

function findActiveNestedSourceTokenAtOffset(
    token: HTMLElement,
    offset: number,
): { token: HTMLElement; from: number } | null {
    const contentRange = readTokenContentRange(token);
    if (!contentRange) return null;

    for (const nested of Array.from(token.querySelectorAll<HTMLElement>(".markdown-token[data-active='true']"))) {
        const nestedRange = readNestedSourceTokenRange(token, nested);
        const from = nestedRange ? contentRange.from + nestedRange.from : null;
        const to = nestedRange ? contentRange.from + nestedRange.to : null;
        if (from !== null && to !== null && offset >= from && offset <= to) {
            return { token: nested, from };
        }
    }
    return null;
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

    if (node.dataset.active === "true" && node.classList.contains(markdownTokenEditingClass)) {
        return getPlainTextDomPoint(node, offset);
    }

    if (offset <= 0) {
        return getElementBoundaryDomPoint(node, false);
    }

    if (offset >= rawSource.length) {
        return getElementBoundaryDomPoint(node, true);
    }

    if (!activateSourceTokens || !node.classList.contains("markdown-token")) {
        return node.classList.contains("markdown-token")
            ? getInactiveSourceTokenDomPoint(node, rawSource, offset)
            : null;
    }

    return activateRawSourceTokenAtOffset(node, rawSource, offset);
}

function activateRawSourceTokenAtOffset(token: HTMLElement, rawSource: string, offset: number): DomPoint {
    if (token.dataset.active === "true" && token.classList.contains(markdownTokenEditingClass)) {
        return getPlainTextDomPoint(token, offset);
    }

    if (token.classList.contains("markdown-code-token")) {
        token.style.setProperty("--markdown-token-preview-width", `${token.getBoundingClientRect().width}px`);
    }
    token.dataset.active = "true";
    delete token.dataset.sourceRaw;
    token.classList.add(markdownTokenEditingClass);
    token.contentEditable = "true";
    token.spellcheck = false;
    token.setAttribute("role", "textbox");
    token.setAttribute("aria-label", "Markdown source");
    token.replaceChildren(document.createTextNode(rawSource));
    return getPlainTextDomPoint(token, offset);
}

function getInactiveSourceTokenDomPoint(token: HTMLElement, rawSource: string, offset: number): DomPoint {
    const previewText = readTokenPreviewText(token);
    const contentRange = readTokenContentRange(token);
    if (!contentRange || previewText.length === 0) {
        return getElementBoundaryDomPoint(token, offset >= rawSource.length / 2);
    }

    const previewOffset = clampOffset(offset - contentRange.from, previewText.length);
    return findTokenPreviewTextPosition(token, previewOffset)
        ?? getElementBoundaryDomPoint(token, previewOffset >= previewText.length);
}

function findTokenPreviewTextPosition(current: Node, offset: number): DomPoint | null {
    if (current.nodeType === Node.TEXT_NODE) {
        const text = current.textContent ?? "";
        const target = clampOffset(offset, stripCaretSpacers(text).length);
        let renderedOffset = 0;
        for (let index = 0; index < text.length; index += 1) {
            if (renderedOffset >= target) {
                return { node: current, offset: index };
            }
            renderedOffset += 1;
        }
        return { node: current, offset: text.length };
    }

    let cursor = 0;
    for (const child of Array.from(current.childNodes)) {
        const length = readTokenPreviewTextFromNode(child);
        if (offset <= cursor + length) {
            const position = findTokenPreviewTextPosition(child, offset - cursor);
            if (position) {
                return position;
            }
        }
        cursor += length;
    }

    return null;
}

export function activateSourceToken(token: HTMLElement, offset = 0): boolean {
    const rawSource = readRawSourceTokenText(token);
    if (rawSource === null || !token.classList.contains("markdown-token")) {
        return false;
    }

    activateRawSourceTokenAtOffset(token, rawSource, offset);
    return true;
}

export function readSourceTokenDocumentRange(token: HTMLElement): { from: number; to: number } | null {
    const block = findBlock(token);
    const content = block ? getBlockContent(block) : null;
    const contentFrom = content ? readDatasetNumber(content.dataset.sourceFrom) : null;
    const tokenRange = content ? readSourceTokenRange(content, token) : null;
    if (contentFrom !== null && tokenRange) {
        return { from: contentFrom + tokenRange.from, to: contentFrom + tokenRange.to };
    }

    const owner = token.parentElement?.closest<HTMLElement>(".markdown-token") ?? null;
    const ownerRange = owner ? readSourceTokenDocumentRange(owner) : null;
    const ownerContentRange = owner ? readTokenContentRange(owner) : null;
    const nestedRange = owner ? readNestedSourceTokenRange(owner, token) : null;
    return ownerRange && ownerContentRange && nestedRange
        ? {
            from: ownerRange.from + ownerContentRange.from + nestedRange.from,
            to: ownerRange.from + ownerContentRange.from + nestedRange.to,
        }
        : null;
}

export function readSourceTokenEditOffsetFromPreviewOffset(
    token: HTMLElement,
    previewOffset: number,
): number {
    const rawSource = readRawSourceTokenText(token) ?? "";
    const contentRange = readTokenContentRange(token);
    if (!contentRange) {
        return readAtomicPreviewEditOffset(rawSource.length, previewOffset, readTokenPreviewText(token).length);
    }

    return clampOffset(
        contentRange.from + readNestedPreviewSourceOffset(token, previewOffset),
        contentRange.to,
    );
}

function readNestedPreviewSourceOffset(node: Node, previewOffset: number): number {
    if (node.nodeType === Node.TEXT_NODE) {
        return clampOffset(previewOffset, stripCaretSpacers(node.textContent ?? "").length);
    }

    const children = Array.from(node.childNodes);
    let previewCursor = 0;
    let sourceCursor = 0;
    for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        const previewLength = readTokenPreviewTextFromNode(child);
        const sourceLength = readNestedSourceSearchLength(child);
        const previewEnd = previewCursor + previewLength;
        if (previewOffset < previewEnd || index === children.length - 1 && previewOffset <= previewEnd) {
            const localOffset = clampOffset(previewOffset - previewCursor, previewLength);
            const rawSource = readRawSourceTokenText(child);
            const contentRange = child instanceof HTMLElement ? readTokenContentRange(child) : null;
            if (rawSource !== null && contentRange) {
                return sourceCursor + contentRange.from + readNestedPreviewSourceOffset(child, localOffset);
            }
            if (rawSource !== null) {
                return sourceCursor + readAtomicPreviewEditOffset(rawSource.length, localOffset, previewLength);
            }
            return sourceCursor + readNestedPreviewSourceOffset(child, localOffset);
        }
        previewCursor = previewEnd;
        sourceCursor += sourceLength;
    }
    return sourceCursor;
}

function readAtomicPreviewEditOffset(rawLength: number, previewOffset: number, previewLength: number): number {
    if (rawLength <= 1) return 0;
    return previewOffset * 2 < previewLength ? 1 : rawLength - 1;
}

function readNestedSourceTokenRange(
    owner: HTMLElement,
    token: HTMLElement,
): { from: number; to: number } | null {
    let cursor = 0;
    for (const child of Array.from(owner.childNodes)) {
        const range = readNestedSourceTokenRangeInNode(child, token, cursor);
        if (range) return range;
        cursor += readNestedSourceSearchLength(child);
    }
    return null;
}

function readNestedSourceTokenRangeInNode(
    node: Node,
    token: HTMLElement,
    start: number,
): { from: number; to: number } | null {
    if (node === token) {
        return { from: start, to: start + readNestedSourceSearchLength(node) };
    }

    if (node instanceof HTMLElement && node.classList.contains("markdown-token")) {
        if (!node.contains(token)) return null;
        const contentRange = readTokenContentRange(node);
        if (!contentRange) return null;
        const nestedRange = readNestedSourceTokenRange(node, token);
        return nestedRange
            ? {
                from: start + contentRange.from + nestedRange.from,
                to: start + contentRange.from + nestedRange.to,
            }
            : null;
    }

    let cursor = start;
    for (const child of Array.from(node.childNodes)) {
        const range = readNestedSourceTokenRangeInNode(child, token, cursor);
        if (range) return range;
        cursor += readNestedSourceSearchLength(child);
    }
    return null;
}

function readNestedSourceSearchLength(node: Node): number {
    const rawSource = readRawSourceTokenText(node);
    if (rawSource !== null) return rawSource.length;
    if (node instanceof HTMLElement && node.dataset.caretSpacer === "true") return 0;
    if (node.nodeType === Node.TEXT_NODE) return stripCaretSpacers(node.textContent ?? "").length;
    return Array.from(node.childNodes).reduce(
        (length, child) => length + readNestedSourceSearchLength(child),
        0,
    );
}

function clearActiveSourceTokensOutsideSelection(): void {
    const state = getEditorState();
    if (state.selection.anchor !== state.selection.head) {
        const selectionFrom = Math.min(state.selection.anchor, state.selection.head);
        const selectionTo = Math.max(state.selection.anchor, state.selection.head);
        const blocksToRender = new Set<HTMLElement>();
        for (const token of Array.from(document.querySelectorAll<HTMLElement>(".markdown-token[data-active='true']"))) {
            const block = findBlock(token);
            const tokenRange = readSourceTokenDocumentRange(token);
            const tokenFrom = tokenRange?.from ?? null;
            const tokenTo = tokenRange?.to ?? null;
            if (
                block &&
                (tokenFrom === null || tokenTo === null ||
                    !(selectionFrom < tokenTo && selectionTo > tokenFrom) &&
                    !doesRangeIntersectPinnedSource(tokenFrom, tokenTo))
            ) {
                blocksToRender.add(block);
            }
        }
        rerenderActiveSourceTokenBlocks(Array.from(blocksToRender));
        return;
    }

    rerenderActiveSourceTokenBlocks(readActiveSourceTokenBlocksOutsideDomSelection());
}

function readActiveSourceTokenBlocksOutsideDomSelection(): HTMLElement[] {
    const selection = document.getSelection();
    const focusNode = selection?.focusNode ?? null;
    const focusedActiveToken = selection?.isCollapsed && focusNode
        ? (focusNode instanceof Element ? focusNode : focusNode.parentElement)?.closest<HTMLElement>(
            ".markdown-token[data-active='true']",
        ) ?? null
        : null;
    return Array.from(
        new Set(
            Array.from(document.querySelectorAll<HTMLElement>(".markdown-token[data-active='true']"))
                .filter((token) => {
                    if (token === focusedActiveToken || token.dataset.sourcePinned === "true") return false;
                    const range = readSourceTokenDocumentRange(token);
                    return !range || !doesRangeIntersectPinnedSource(range.from, range.to);
                })
                .map((token) => findBlock(token))
                .filter((block): block is HTMLElement => Boolean(block)),
        ),
    );
}

function readAllActiveSourceTokenBlocks(): HTMLElement[] {
    return Array.from(
        new Set(
            Array.from(document.querySelectorAll<HTMLElement>(".markdown-token[data-active='true']"))
                .filter((token) => token.dataset.sourcePinned !== "true")
                .map((token) => findBlock(token))
                .filter((block): block is HTMLElement => Boolean(block)),
        ),
    );
}

function rerenderActiveSourceTokenBlocks(blocks: HTMLElement[]): boolean {
    let rerendered = false;
    for (const block of blocks) {
        if (!block.isConnected) {
            continue;
        }

        setBlockText(block, getBlockText(block));
        rerendered = true;
    }

    return rerendered;
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

function readAtomicBlockContentBoundaryOffset(
    block: HTMLElement,
    content: HTMLElement,
    sourceBlock: SourceBlock,
    node: Node,
    offset: number,
): number | null {
    if (node !== content) {
        return null;
    }

    const source = getBlockSourceElement(content, "atomic");
    if (!source) {
        return null;
    }

    const preview = Array.from(content.children).find(
        (child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains("format-block-preview"),
    );
    const representative = block.dataset.blockSourceActive === "true" || !preview ? source : preview;
    const representativeIndex = Array.from(content.childNodes).indexOf(representative);
    if (representativeIndex < 0) {
        return null;
    }

    return offset <= representativeIndex ? sourceBlock.sourceFrom : sourceBlock.sourceTo;
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
