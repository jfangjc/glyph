import {
    sourceBlocksInRange,
    findSourceBlockAtOffset,
    resolveVisibleSourceOffset,
    isSourceSelection,
    type SelectionRange,
    type SourceAffinity,
    type SourceBlock,
    type Transaction,
} from "./types";
import {
    dispatch,
    getEditorState,
} from "./store";
import {
    ensureBlockSourceRendered,
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
} from "../selection/rendered-content-dom";
import { getElement } from "../../utils/dom";
import type { ProjectionCapability } from "./types";
import { nextGraphemeBoundary, previousGraphemeBoundary } from "../../utils/text-boundaries";
import { getCaretPositionFromPoint } from "../selection/caret";

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

const projectedBlocks = new Map<string, HTMLElement>();
const activeSourceTokens = new Set<HTMLElement>();
const activeSourceBlocks = new Set<HTMLElement>();

export function registerProjectedBlocks(blocks: HTMLElement[]): void {
    projectedBlocks.clear();
    for (const block of blocks) if (block.dataset.blockId) projectedBlocks.set(block.dataset.blockId, block);
    readActiveSourceTokens();
    for (const block of activeSourceBlocks) if (!block.isConnected) activeSourceBlocks.delete(block);
}

export function setBlockSourceActive(block: HTMLElement, active: boolean): void {
    if (active) {
        activeSourceBlocks.add(block);
        if (block.dataset.blockSourceActive !== "true") block.dataset.blockSourceActive = "true";
    } else {
        activeSourceBlocks.delete(block);
        if (block.dataset.blockSourceActive !== undefined) delete block.dataset.blockSourceActive;
    }
}

function readActiveSourceTokens(): HTMLElement[] {
    for (const token of activeSourceTokens) {
        if (!token.isConnected || token.dataset.active !== "true") activeSourceTokens.delete(token);
    }
    return Array.from(activeSourceTokens);
}

function sourceTokensInRange(from: number, to: number): HTMLElement[] {
    return Array.from(sourceBlocksInRange(getEditorState().blocks, from, to)).flatMap(block =>
        Array.from(findProjectedBlockElement(block.id)?.querySelectorAll<HTMLElement>(".markdown-token[data-source-raw]") ?? []));
}

export function isProjectedDomSelection(): boolean {
    const selection = document.getSelection();
    return Boolean(selection && projectedDomSelection && domSelectionMatchesSnapshot(selection, projectedDomSelection));
}

let projectedDomSelection: DomSelectionSnapshot | null = null;
let compositionSurface: HTMLElement | null = null;

export function setCompositionSurface(surface: HTMLElement | null): void { compositionSurface = surface; }
export function isCompositionSurfaceActive(node?: Node): boolean {
    return Boolean(compositionSurface?.isConnected && (!node || compositionSurface.contains(node) || node.contains(compositionSurface)));
}

type SourceOffsetToDomPointOptions = {
    revealSource?: boolean;
    affinity?: SourceAffinity;
};

const markdownTokenEditingClass = "markdown-token-editing";
let verticalNavigationAffinity: { preferredColumn: number; preferredX?: number; revision: number } | null = null;
let activeProjectionCapability: ProjectionCapability | undefined;
let pinnedSourceRevealRange: { from: number; to: number } | null = null;
let typingSourceRevealRange: { from: number; to: number } | null = null;

export function configureProjectionCapability(capability: ProjectionCapability | undefined): void {
    activeProjectionCapability = capability;
}

export function applySourceBlockProjectionMetadata(
    blockElement: HTMLElement,
    block: SourceBlock,
    documentSource: string,
): void {
    setProjectionData(blockElement, "blockId", block.id);
    setProjectionData(blockElement, "sourceFrom", String(block.sourceFrom));
    setProjectionData(blockElement, "sourceTo", String(block.sourceTo));
    setProjectionData(blockElement, "contentFrom", String(block.contentFrom));
    setProjectionData(blockElement, "contentTo", String(block.contentTo));

    const content = getBlockContent(blockElement);
    setProjectionData(content, "sourceFrom", String(block.contentFrom));
    setProjectionData(content, "sourceTo", String(block.contentTo));

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

    const prefix = getBlockSourceElement(content, "prefix");
    const suffix = getBlockSourceElement(content, "suffix");
    if (prefix) {
        updateSourceElementText(prefix, documentSource.slice(block.sourceFrom, block.contentFrom));
    }
    if (suffix) {
        updateSourceElementText(suffix, documentSource.slice(block.contentTo, block.sourceTo));
    }

    applyPrefixSourceElementRange(prefix, block.sourceFrom, block.contentFrom);
    applySourceElementRange(suffix, block.sourceTo, "end");
    applySourceElementRange(getBlockSourceElement(content, "atomic"), block.sourceFrom);
}

function setProjectionData(element: HTMLElement, key: string, value: string): void {
    if (element.dataset[key] !== value) element.dataset[key] = value;
}

export function sourceOffsetToDomPoint(offset: number, options: SourceOffsetToDomPointOptions = {}): DomPoint {
    const state = getEditorState();
    const clampedOffset = clampOffset(offset, state.doc.length);
    const sourceBlock = findSourceBlockAtOffset(state.blocks, clampedOffset, options.affinity);
    const blockElement = sourceBlock ? findProjectedBlockElement(sourceBlock.id) : null;
    if (!sourceBlock || !blockElement) {
        return fallbackEditorDomPoint();
    }

    applySourceBlockProjectionMetadata(blockElement, sourceBlock, state.doc);

    const content = getBlockContent(blockElement);
    const sourcePoint = findSourceElementDomPoint(content, clampedOffset, options.revealSource ?? false, options.affinity ?? "downstream");
    if (sourcePoint) {
        return sourcePoint;
    }

    const bodyOffset = clampOffset(clampedOffset - sourceBlock.contentFrom, sourceBlock.contentTo - sourceBlock.contentFrom);
    const sourceTokenPoint = findSourceTokenDomPoint(content, bodyOffset, options.revealSource ?? false, options.affinity ?? "downstream");
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

export function moveSourceSelectionVertically(
    direction: "up" | "down",
    options: { extend?: boolean } = {},
): boolean {
    const state = getEditorState();
    if (verticalNavigationAffinity?.revision !== state.revision) {
        verticalNavigationAffinity = null;
    }

    const currentLine = readSourceLineAtOffset(state.doc, state.selection.head);
    const visual = readVisualNavigationTarget(direction === "up" ? "backward" : "forward", "line", verticalNavigationAffinity?.preferredX);
    const targetLine = readAdjacentSourceLine(state.doc, currentLine, direction);
    if (!targetLine && !visual) {
        resetVerticalNavigationAffinity();
        return false;
    }

    const preferredColumn = verticalNavigationAffinity?.preferredColumn
        ?? readNavigationColumn(state, currentLine, state.selection.head);
    // Grid/list boundaries can leave Selection.modify at the same source
    // position. Do not consume an arrow without trying the source-line fallback.
    const movedVisual = visual?.offset !== state.selection.head ? visual : null;
    const target = movedVisual?.offset ?? (targetLine ? readVerticalNavigationTarget(state, currentLine, targetLine, preferredColumn, direction) : null);
    if (target === null) {
        resetVerticalNavigationAffinity();
        return false;
    }

    dispatch({
        changes: [],
        selection: {
            anchor: options.extend ? state.selection.anchor : target,
            head: target,
            anchorAffinity: options.extend ? state.selection.anchorAffinity : "downstream",
            source: selectionTouchesSource({
                anchor: options.extend ? state.selection.anchor : target,
                head: target,
            }),
        },
        annotations: { userEvent: "programmatic", addToHistory: false },
    });
    verticalNavigationAffinity = {
        preferredColumn,
        preferredX: movedVisual?.preferredX ?? verticalNavigationAffinity?.preferredX,
        revision: getEditorState().revision,
    };
    syncDomSelectionFromState({ scrollIntoView: true });
    return true;
}

export function readVisualLineBoundary(direction: "backward" | "forward"): number | null {
    return readVisualNavigationTarget(direction, "lineboundary")?.offset ?? null;
}

function readVisualNavigationTarget(
    direction: "backward" | "forward",
    granularity: "line" | "lineboundary",
    preferredX?: number,
): { offset: number; preferredX: number } | null {
    const selection = document.getSelection();
    const editor = document.getElementById("editor");
    if (!selection || !editor || typeof selection.modify !== "function" || isCompositionSurfaceActive()) return null;
    const state = getEditorState();
    const point = sourceOffsetToDomPoint(state.selection.head, {
        affinity: state.selection.headAffinity,
        revealSource: isSourceSelection(state.selection),
    });
    const saved = readDomSelectionSnapshot(selection);
    const range = document.createRange();
    range.setStart(point.node, point.offset);
    range.collapse(true);
    const rect = readCaretGeometry(state.selection.head, state.selection.headAffinity) ?? range.getClientRects()[0];
    const x = preferredX ?? rect?.left;
    if (x === undefined) return null;
    try {
        selection.setBaseAndExtent(point.node, point.offset, point.node, point.offset);
        // The layout engine resolves wrapping, bidi text, inline objects and
        // font metrics; all endpoints still enter the shared source mapping.
        selection.modify("move", direction, granularity);
        let node = selection.focusNode;
        let offset = selection.focusOffset;
        if (!node || !editor.contains(node)) return null;
        if (granularity === "line" && selection.rangeCount) {
            const targetRect = selection.getRangeAt(0).getClientRects()[0];
            if (targetRect && rect && Math.abs(targetRect.top - rect.top) > 1) {
                const hit = getCaretPositionFromPoint(x, targetRect.top + targetRect.height / 2);
                if (hit && editor.contains(hit.node)) { node = hit.node; offset = hit.offset; }
            }
        }
        const rawOffset = domPointToSourceOffset(node, offset);
        const next = nextGraphemeBoundary(state.doc, rawOffset);
        const snapped = rawOffset === state.doc.length ? rawOffset : previousGraphemeBoundary(state.doc, next);
        return { offset: snapped, preferredX: x };
    } finally {
        if (saved.anchorNode?.isConnected && saved.focusNode?.isConnected) {
            selection.setBaseAndExtent(saved.anchorNode, saved.anchorOffset, saved.focusNode, saved.focusOffset);
        }
    }
}

function readCaretGeometry(offset: number, affinity: SourceAffinity = "downstream"): DOMRect | null {
    const state = getEditorState();
    const doc = state.doc;
    const backward = affinity === "upstream" || offset === doc.length;
    const adjacent = backward ? previousGraphemeBoundary(doc, offset) : nextGraphemeBoundary(doc, offset);
    if (adjacent === offset || doc.slice(Math.min(offset, adjacent), Math.max(offset, adjacent)).includes("\n")) return null;
    const options = { revealSource: isSourceSelection(state.selection), affinity };
    const start = sourceOffsetToDomPoint(Math.min(offset, adjacent), options);
    const end = sourceOffsetToDomPoint(Math.max(offset, adjacent), options);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const rects = Array.from(range.getClientRects());
    const rect = backward ? rects[rects.length - 1] : rects[0];
    return rect ? new DOMRect(backward ? rect.right : rect.left, rect.top, 0, rect.height) : null;
}

export function resetVerticalNavigationAffinity(): void {
    verticalNavigationAffinity = null;
}

function readNavigationColumn(
    state: ReturnType<typeof getEditorState>,
    line: { from: number; to: number },
    offset: number,
): number {
    return Math.max(0, offset - line.from);
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

    const target = Math.min(targetLine.to, targetLine.from + preferredColumn);
    const snapped = target === state.doc.length ? target : previousGraphemeBoundary(state.doc, nextGraphemeBoundary(state.doc, target));
    return resolveVisibleSourceOffset(state.blocks, snapped, direction === "up" ? "backward" : "forward");
}

// Projection-only DOM reader: translates a browser DOM point to a canonical
// EditorState.doc UTF-16 offset. It must not be used to recover source text.
export function domPointToSourceOffset(node: Node, offset: number): number {
    const state = getEditorState();
    if (node === document.getElementById("editor")) {
        // Native movement across grid items can return a point on the editor
        // itself, not a text node. Resolve that boundary into the next visible
        // body (or the previous body's end at EOF), independently of old state.
        const children = Array.from(node.childNodes);
        for (let index = offset; index < children.length; index += 1) {
            const child = children[index];
            if (child instanceof HTMLElement && child.dataset.blockId) return readProjectedBlockBoundary(child, "start");
        }
        for (let index = Math.min(offset, children.length) - 1; index >= 0; index -= 1) {
            const child = children[index];
            if (child instanceof HTMLElement && child.dataset.blockId) return readProjectedBlockBoundary(child, "end");
        }
        return 0;
    }
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
        // Task items have a checkbox before their content. A point after that
        // checkbox is still before the text, not at the end of the item.
        const contentIndex = Array.from(block.childNodes).indexOf(content);
        return readProjectedBlockBoundary(block, offset <= contentIndex ? "start" : "end");
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

function readProjectedBlockBoundary(block: HTMLElement, edge: "start" | "end"): number {
    const sourceVisible = block.dataset.blockSourceActive === "true";
    const atomic = ["table", "math", "html", "definition-list", "rule"].includes(block.dataset.type ?? "");
    const boundary = edge === "start"
        ? sourceVisible || atomic ? block.dataset.sourceFrom : block.dataset.contentFrom
        : sourceVisible || atomic ? block.dataset.sourceTo : block.dataset.contentTo;
    return readDatasetNumber(boundary) ?? 0;
}

export function syncDomSelectionFromState(
    options: { focus?: "preserve" | "editor"; scrollIntoView?: boolean } = { focus: "editor" },
): void {
    if (isCompositionSurfaceActive()) return;
    const state = getEditorState();
    const selection = document.getSelection();
    if (!selection) {
        return;
    }

    const focusOwner = options.focus === "preserve" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    syncSourceRevealFromState();

    const sourceSelectionFrom = Math.min(state.selection.anchor, state.selection.head);
    const sourceSelectionTo = Math.max(state.selection.anchor, state.selection.head);
    if (isSourceSelection(state.selection) && sourceSelectionFrom !== sourceSelectionTo) {
        revealSourceTokensInRange(sourceSelectionFrom, sourceSelectionTo);
    }

    const displaySelection = activeProjectionCapability?.resolveSelectionRange?.(state) ?? {
        from: Math.min(state.selection.anchor, state.selection.head),
        to: Math.max(state.selection.anchor, state.selection.head),
    };
    const forward = state.selection.anchor <= state.selection.head;
    const displayAnchor = forward ? displaySelection.from : displaySelection.to;
    const displayHead = forward ? displaySelection.to : displaySelection.from;
    const revealSource = isSourceSelection(state.selection);

    const anchor = sourceOffsetToDomPoint(displayAnchor, {
        revealSource,
        affinity: state.selection.anchorAffinity,
    });
    const head = sourceOffsetToDomPoint(displayHead, {
        revealSource,
        affinity: state.selection.headAffinity,
    });
    const editor = getElement<HTMLElement>("editor");
    const range = document.createRange();

    if (options.focus !== "preserve") {
        editor.focus({ preventScroll: true });
    }
    if (selection.anchorNode !== anchor.node || selection.anchorOffset !== anchor.offset ||
        selection.focusNode !== head.node || selection.focusOffset !== head.offset) {
        range.setStart(anchor.node, anchor.offset);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        if (state.selection.anchor !== state.selection.head) selection.extend(head.node, head.offset);
    }
    if (options.scrollIntoView) scrollSelectionHeadIntoView(head);

    projectedDomSelection = readDomSelectionSnapshot(selection);

    if (focusOwner && focusOwner !== editor && focusOwner.isConnected) {
        focusOwner.focus({ preventScroll: true });
    }
}

export function syncStateSelectionFromDom(): boolean {
    if (isCompositionSurfaceActive()) return false;
    const selection = document.getSelection();
    if (!selection?.anchorNode || !selection.focusNode) {
        return false;
    }

    if (projectedDomSelection && domSelectionMatchesSnapshot(selection, projectedDomSelection)) {
        return false;
    }
    projectedDomSelection = null;

    const state = getEditorState();
    const sourceAnchor = selectionBoundaryToSourceOffset(selection, "anchor");
    const sourceHead = selectionBoundaryToSourceOffset(selection, "focus");
    const domOwnsSource = readDomSelectionOwnsSource(selection);
    const nextSelection: SelectionRange = {
        anchor: sourceAnchor,
        head: sourceHead,
        anchorAffinity: readDomBoundaryAffinity(selection.anchorNode, selection.anchorOffset),
        headAffinity: readDomBoundaryAffinity(selection.focusNode, selection.focusOffset),
        source: domOwnsSource || selectionTouchesSource({ anchor: sourceAnchor, head: sourceHead }),
    };
    if (
        nextSelection.anchor === state.selection.anchor &&
        nextSelection.head === state.selection.head &&
        nextSelection.anchorAffinity === state.selection.anchorAffinity &&
        nextSelection.headAffinity === state.selection.headAffinity &&
        Boolean(nextSelection.source) === Boolean(state.selection.source)
    ) {
        return false;
    }

    dispatch({
        changes: [],
        selection: nextSelection,
        annotations: { userEvent: "programmatic", addToHistory: false },
    });
    return true;
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
    const activeTokens = readActiveSourceTokens();
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
            doesSelectionOwnSourceToken(state.selection, tokenFrom, tokenTo) ||
            token.dataset.sourcePinned === "true" ||
            tokenFrom !== null && tokenTo !== null && Boolean(
                state.selection.anchor === state.selection.head &&
                typingSourceRevealRange &&
                tokenFrom === typingSourceRevealRange.from &&
                tokenTo === typingSourceRevealRange.to &&
                state.selection.head === tokenTo,
            ) ||
            tokenFrom !== null && tokenTo !== null && doesRangeIntersectPinnedSource(tokenFrom, tokenTo),
        );
        if (!selectionInsideToken) {
            blocksToRender.add(block);
        }
    }

    for (const block of blocksToRender) {
        const sourceBlock = findSourceBlockAtOffset(state.blocks, Number(block.dataset.sourceFrom));
        if (sourceBlock) {
            setBlockText(block, state.doc.slice(sourceBlock.contentFrom, sourceBlock.contentTo));
        }
    }
}

export function syncInlineTypingSourceReveal(
    state: ReturnType<typeof getEditorState>,
    transaction: Transaction | undefined,
): void {
    typingSourceRevealRange = null;
    if (
        transaction?.annotations?.userEvent !== "input" ||
        transaction.changes.length !== 1
    ) {
        return;
    }

    const change = transaction.changes[0];
    if (!change.insert || !Array.from(change.insert).every(isMarkdownDelimiterCharacter)) {
        return;
    }

    const insertionEnd = change.from + change.insert.length;
    const candidates = sourceTokensInRange(insertionEnd, insertionEnd)
        .map((token) => ({ token, range: readSourceTokenDocumentRange(token) }))
        .filter((candidate): candidate is { token: HTMLElement; range: { from: number; to: number } } => Boolean(
            candidate.range &&
            insertionEnd >= candidate.range.from &&
            insertionEnd <= candidate.range.to,
        ))
        .sort((left, right) =>
            (left.range.to - left.range.from) - (right.range.to - right.range.from));
    const candidate = candidates.find((entry) => entry.range.to === insertionEnd);
    const finalDelimiter = change.insert.at(-1) ?? "";
    if (
        !candidate ||
        state.doc[candidate.range.from - 1] !== finalDelimiter
    ) {
        return;
    }

    typingSourceRevealRange = candidate.range;
    activateSourceToken(
        candidate.token,
        Math.max(0, Math.min(insertionEnd - candidate.range.from, candidate.range.to - candidate.range.from)),
    );
    candidate.token.dataset.sourceTyping = "true";
    // Keep only a prematurely parsed suffix raw (for example the `*bold*`
    // inside an unfinished `**bold*`). A completed construct whose opening
    // delimiter starts at the full run renders immediately.
}

export function clearInlineTypingSourceReveal(): void {
    typingSourceRevealRange = null;
}

function isMarkdownDelimiterCharacter(character: string): boolean {
    return "*_~`$[]()".includes(character);
}

function revealSourceTokensInRange(selectionFrom: number, selectionTo: number, reconcileOthers = true): boolean {
    const blocksToRender = new Set<HTMLElement>();
    for (const token of reconcileOthers ? readActiveSourceTokens() : []) {
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
    const sourceTokens = sourceTokensInRange(selectionFrom, selectionTo);
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
    for (const token of readActiveSourceTokens().filter(token => token.dataset.sourcePinned === "true")) {
        const tokenRange = readSourceTokenDocumentRange(token);
        if (!range || !tokenRange || range.from >= tokenRange.to || range.to <= tokenRange.from) delete token.dataset.sourcePinned;
    }
    pinnedSourceRevealRange = range;
    if (range) {
        revealSourceTokensInRange(range.from, range.to);
        for (const token of readActiveSourceTokens()) {
            const tokenRange = readSourceTokenDocumentRange(token);
            if (tokenRange && range.from < tokenRange.to && range.to > tokenRange.from) {
                if (token.dataset.sourcePinned !== "true") token.dataset.sourcePinned = "true";
            }
        }
    } else {
        reconcileActiveSourceTokensFromState(getEditorState());
    }
}

function doesSelectionOwnSourceToken(
    selection: SelectionRange,
    tokenFrom: number,
    tokenTo: number,
): boolean {
    return isSourceSelection(selection) && selectionIntersectsSourceRange(selection, tokenFrom, tokenTo);
}

export function selectionTouchesSource(next: SelectionRange): boolean {
    const state = getEditorState();
    return selectionTouchesMarkdownSource(state, next);
}

function selectionTouchesMarkdownSource(
    state: ReturnType<typeof getEditorState>,
    selection: SelectionRange,
): boolean {
    const from = Math.min(selection.anchor, selection.head);
    const to = Math.max(selection.anchor, selection.head);
    const touches = (range: { from: number; to: number }) => selectionIntersectsSourceRange(selection, range.from, range.to);
    if ((activeProjectionCapability?.readVisualHiddenRanges?.(state, { from, to }) ?? [])
        .some(touches)) {
        return true;
    }

    return Array.from(sourceBlocksInRange(state.blocks, from, to)).some((block) => selectionTouchesBlockSource(block, from, to, selection.headAffinity));
}

function selectionTouchesBlockSource(block: SourceBlock, from: number, to: number, affinity: SourceAffinity = "downstream"): boolean {
    const touches = (rangeFrom: number, rangeTo: number) => rangeFrom < rangeTo && (from === to
        ? selectionIntersectsSourceRange({ anchor: from, head: to, headAffinity: affinity }, rangeFrom, rangeTo)
        : from < rangeTo && to > rangeFrom);
    return ["code", "table", "math", "html", "definition-list", "rule"].includes(block.type)
        ? touches(block.sourceFrom, block.sourceTo)
        : touches(block.sourceFrom, block.contentFrom) || touches(block.contentTo, block.sourceTo);
}

function doesRangeIntersectPinnedSource(from: number, to: number): boolean {
    return Boolean(pinnedSourceRevealRange && pinnedSourceRevealRange.from < to && pinnedSourceRevealRange.to > from);
}

export function clearSourceReveal(): void {
    if (isCompositionSurfaceActive()) return;
    clearInlineTypingSourceReveal();
    rerenderActiveSourceTokenBlocks(readAllActiveSourceTokenBlocks());
    for (const block of activeSourceBlocks) setBlockSourceActive(block, false);
    if (pinnedSourceRevealRange) setPinnedSourceRevealRange(pinnedSourceRevealRange);
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

    const visibleRange = readTokenContentRange(token);
    const tokenOffset = visibleRange
        ? tokenRange.from + (edge === "start" ? visibleRange.from : visibleRange.to)
        : edge === "start" ? tokenRange.from : tokenRange.to;
    return clampOffset(contentFrom + tokenOffset, getEditorState().doc.length);
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
    const from = clampedOffset === 0 ? 0 : doc.lastIndexOf("\n", clampedOffset - 1) + 1;
    const nextBreak = doc.indexOf("\n", clampedOffset);
    return {
        from,
        to: nextBreak < 0 ? doc.length : nextBreak,
    };
}

function readSourceLineEndingAtOffset(doc: string, offset: number): { from: number; to: number } {
    const to = clampOffset(offset, doc.length);
    const from = to === 0 ? 0 : doc.lastIndexOf("\n", to - 1) + 1;
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

    setProjectionData(source, "sourceFrom", String(sourceFrom));
    setProjectionData(source, "sourceTo", String(sourceTo));
    if (source.dataset.sourceHiddenPrefixLength !== undefined) delete source.dataset.sourceHiddenPrefixLength;
}

function applyPrefixSourceElementRange(source: HTMLElement | null, sourceFrom: number, sourceTo: number): void {
    if (!source) {
        return;
    }

    const textLength = source.textContent?.length ?? 0;
    const hiddenPrefixLength = Math.max(0, sourceTo - sourceFrom - textLength);

    setProjectionData(source, "sourceFrom", String(sourceFrom));
    setProjectionData(source, "sourceTo", String(sourceTo));
    if (hiddenPrefixLength > 0) {
        setProjectionData(source, "sourceHiddenPrefixLength", String(hiddenPrefixLength));
    } else {
        if (source.dataset.sourceHiddenPrefixLength !== undefined) delete source.dataset.sourceHiddenPrefixLength;
    }
}

function findProjectedBlockElement(blockId: string): HTMLElement | null {
    const block = projectedBlocks.get(blockId);
    return block?.isConnected ? block : null;
}

function findSourceElementDomPoint(content: HTMLElement, offset: number, activateBlockSource: boolean, affinity: SourceAffinity): DomPoint | null {
    for (const source of Array.from(content.querySelectorAll<HTMLElement>(".format-block-source"))) {
        const sourceFrom = readDatasetNumber(source.dataset.sourceFrom);
        const sourceTo = readDatasetNumber(source.dataset.sourceTo);
        const sourceBlockElement = source.closest<HTMLElement>("[data-block]");
        const ownsBlockSource = activateBlockSource && sourceBlockElement?.dataset.blockSourceActive === "true";
        if (
            sourceFrom === null || sourceTo === null ||
            !isOffsetInsideSourceElement(source, offset, sourceFrom, sourceTo, ownsBlockSource, affinity)
        ) {
            continue;
        }

        if (ownsBlockSource) {
            return getBlockSourceDomPoint(source, offset - sourceFrom);
        }

        return getInactiveBlockSourceDomPoint(content, source, offset, sourceFrom, sourceTo);
    }

    return null;
}

function syncSourceRevealFromState(): void {
    const state = getEditorState();
    reconcileActiveSourceTokensFromState(state);
    // A local block rerender can also replace a pinned token in that block.
    if (pinnedSourceRevealRange) {
        revealSourceTokensInRange(pinnedSourceRevealRange.from, pinnedSourceRevealRange.to, false);
        for (const token of readActiveSourceTokens()) {
            const range = readSourceTokenDocumentRange(token);
            if (range && doesRangeIntersectPinnedSource(range.from, range.to) && token.dataset.sourcePinned !== "true") {
                token.dataset.sourcePinned = "true";
            }
        }
    }
    syncBlockSourceActivationFromState(state);
}

function syncBlockSourceActivationFromState(state: ReturnType<typeof getEditorState>): void {
    const activeBlockIds = new Set<string>();
    if (isSourceSelection(state.selection)) {
        const selectionFrom = Math.min(state.selection.anchor, state.selection.head);
        const selectionTo = Math.max(state.selection.anchor, state.selection.head);
        for (const sourceBlock of sourceBlocksInRange(state.blocks, selectionFrom, selectionTo)) {
            if (selectionTouchesBlockSource(sourceBlock, selectionFrom, selectionTo, state.selection.headAffinity)) {
                activeBlockIds.add(sourceBlock.id);
            }
        }
    }
    for (const block of activeSourceBlocks) {
        if (!block.isConnected || !activeBlockIds.has(block.dataset.blockId ?? "")) setBlockSourceActive(block, false);
    }
    for (const id of activeBlockIds) {
        const block = findProjectedBlockElement(id);
        if (!block) continue;
        ensureBlockSourceRendered(block);
        setBlockSourceActive(block, true);
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


function isOffsetInsideSourceElement(
    source: HTMLElement,
    offset: number,
    sourceFrom: number,
    sourceTo: number,
    ownsBlockSource: boolean,
    affinity: SourceAffinity,
): boolean {
    const position = readBlockSourcePosition(source);
    const isCodeSource = source.closest<HTMLElement>("[data-block]")?.dataset.type === "code";
    if (position === "prefix") {
        return offset >= sourceFrom && (offset < sourceTo || offset === sourceTo &&
            (isCodeSource || ownsBlockSource && affinity === "upstream"));
    }

    if (position === "suffix") {
        return offset <= sourceTo && (offset > sourceFrom || offset === sourceFrom &&
            (isCodeSource || ownsBlockSource && affinity === "downstream"));
    }

    return offset >= sourceFrom && offset <= sourceTo;
}

function findSourceTokenDomPoint(root: HTMLElement, offset: number, activateSourceTokens: boolean, affinity: SourceAffinity): DomPoint | null {
    let cursor = 0;
    for (const child of Array.from(root.childNodes)) {
        const length = readSourceTokenSearchLength(child);
        const targetIsInChild = offset < cursor + length || isRawSourceTokenBoundary(child, offset - cursor);
        if (!targetIsInChild) {
            cursor += length;
            continue;
        }

        const position = findSourceTokenDomPointInNode(child, offset - cursor, activateSourceTokens, affinity);
        if (position !== undefined) {
            return position;
        }

        return null;
    }

    return null;
}

function readDomSelectionOwnsSource(selection: Selection): boolean {
    const anchorElement = selection.anchorNode instanceof Element
        ? selection.anchorNode
        : selection.anchorNode?.parentElement;
    const focusElement = selection.focusNode instanceof Element
        ? selection.focusNode
        : selection.focusNode?.parentElement;
    const sourceSelector = ".markdown-token-editing, .format-block-source";
    if (anchorElement?.closest(sourceSelector) || focusElement?.closest(sourceSelector)) {
        return true;
    }

    const focusBlock = selection.isCollapsed ? findBlock(selection.focusNode) : null;
    if (focusBlock?.dataset.type === "code") {
        return true;
    }
    return false;
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
    return (token.textContent ?? "");
}

function getTokenPreviewBoundaryOffset(current: Node, anchorNode: Node, anchorOffset: number): number {
    if (current === anchorNode) {
        if (current.nodeType === Node.TEXT_NODE) {
            return (current.textContent ?? "").slice(0, anchorOffset).length;
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
    return (node.textContent ?? "").length;
}

function readTokenContentRange(token: HTMLElement): { from: number; to: number } | null {
    const from = readDatasetNumber(token.dataset.sourceContentFrom);
    const to = readDatasetNumber(token.dataset.sourceContentTo);
    return from === null || to === null ? null : { from, to };
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

    while (candidate?.nodeType === Node.TEXT_NODE && (candidate.textContent ?? "") === "") {
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
        const before = text.slice(0, offset);
        const after = text.slice(offset);

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
    affinity: SourceAffinity,
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
                    affinity,
                );
            }
        }
        if (offset >= 0 && offset <= rawSource.length) {
            return readRawSourceTokenDomPoint(node, rawSource, offset, activateSourceTokens, affinity);
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

        const position = findSourceTokenDomPointInNode(child, offset - cursor, activateSourceTokens, affinity);
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
            return (current.textContent ?? "").slice(0, anchorOffset).length;
        }

        return Array.from(current.childNodes)
            .slice(0, Math.max(0, anchorOffset))
            .reduce((length, child) => length + readNestedSourceSearchLength(child), 0);
    }

    let sourceOffset = 0;
    for (const child of Array.from(current.childNodes)) {
        if (child === anchorNode || child.contains(anchorNode)) {
            const raw = readRawSourceTokenText(child);
            if (raw !== null && child instanceof HTMLElement && child.classList.contains("markdown-token")) {
                return sourceOffset + (child.classList.contains(markdownTokenEditingClass)
                    ? getTokenPreviewBoundaryOffset(child, anchorNode, anchorOffset)
                    : readInactiveTokenRawOffset(child, raw, anchorNode, anchorOffset));
            }
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
    affinity: SourceAffinity,
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
            ? getInactiveSourceTokenDomPoint(node, rawSource, offset, affinity)
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
    activeSourceTokens.add(token);
    token.dataset.active = "true";
    delete token.dataset.sourceRaw;
    token.classList.add(markdownTokenEditingClass);
    token.contentEditable = "true";
    token.spellcheck = false;
    token.setAttribute("role", "textbox");
    token.setAttribute("aria-label", "Markdown source");
    const contentRange = readTokenContentRange(token);
    if (contentRange) {
        const opening = createMarkdownDelimiterSegment(rawSource.slice(0, contentRange.from));
        const content = document.createElement("span");
        content.className = "markdown-source-content";
        preserveMarkdownContentStyle(token, content);
        content.textContent = rawSource.slice(contentRange.from, contentRange.to);
        const closing = createMarkdownDelimiterSegment(rawSource.slice(contentRange.to));
        token.replaceChildren(opening, content, closing);
    } else {
        token.replaceChildren(document.createTextNode(rawSource));
    }
    return getPlainTextDomPoint(token, offset);
}

function preserveMarkdownContentStyle(token: HTMLElement, content: HTMLElement): void {
    const styleClasses = [
        "markdown-strong",
        "markdown-emphasis",
        "markdown-strikethrough",
        "markdown-highlight",
        "markdown-subscript",
        "markdown-superscript",
        "markdown-link",
    ];
    for (const className of styleClasses) {
        if (token.querySelector(`.${className}`)) content.classList.add(className);
    }
}

function createMarkdownDelimiterSegment(value: string): HTMLElement {
    const delimiter = document.createElement("span");
    delimiter.className = "markdown-source-delimiter";
    delimiter.textContent = value;
    return delimiter;
}

function getInactiveSourceTokenDomPoint(token: HTMLElement, rawSource: string, offset: number, affinity: SourceAffinity): DomPoint {
    if (offset <= 0 || offset >= rawSource.length) return getElementBoundaryDomPoint(token, offset > 0);
    const previewText = readTokenPreviewText(token);
    const contentRange = readTokenContentRange(token);
    if (!contentRange || previewText.length === 0) {
        return getElementBoundaryDomPoint(token, offset > rawSource.length / 2 || (offset === rawSource.length / 2 && affinity === "downstream"));
    }

    const contentOffset = clampOffset(offset - contentRange.from, contentRange.to - contentRange.from);
    return findNestedSourceTextPosition(token, contentOffset, affinity)
        ?? getElementBoundaryDomPoint(token, offset >= contentRange.to);
}

function findNestedSourceTextPosition(current: Node, offset: number, affinity: SourceAffinity): DomPoint | null {
    if (current.nodeType === Node.TEXT_NODE) {
        return { node: current, offset: clampOffset(offset, (current.textContent ?? "").length) };
    }

    let cursor = 0;
    for (const child of Array.from(current.childNodes)) {
        const length = readNestedSourceSearchLength(child);
        if (offset < cursor + length || (offset === cursor + length && (affinity === "upstream" || !child.nextSibling))) {
            const raw = readRawSourceTokenText(child);
            const position = raw !== null && child instanceof HTMLElement
                ? child.classList.contains(markdownTokenEditingClass)
                    ? getPlainTextDomPoint(child, offset - cursor)
                    : getInactiveSourceTokenDomPoint(child, raw, offset - cursor, affinity)
                : findNestedSourceTextPosition(child, offset - cursor, affinity);
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
        return clampOffset(previewOffset, (node.textContent ?? "").length);
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
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").length;
    return Array.from(node.childNodes).reduce(
        (length, child) => length + readNestedSourceSearchLength(child),
        0,
    );
}

function readAllActiveSourceTokenBlocks(): HTMLElement[] {
    return Array.from(
        new Set(
            readActiveSourceTokens()
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
    let remaining = Math.max(0, offset);
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    while (text) {
        const length = text.textContent?.length ?? 0;
        if (remaining <= length) {
            return { node: text, offset: remaining };
        }
        remaining -= length;
        text = walker.nextNode();
    }
    const fallback = element.appendChild(document.createTextNode(""));
    return { node: fallback, offset: 0 };
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

function selectionIntersectsSourceRange(selection: SelectionRange, from: number, to: number): boolean {
    const start = Math.min(selection.anchor, selection.head);
    const end = Math.max(selection.anchor, selection.head);
    if (start !== end) return start < to && end > from;
    return start > from && start < to ||
        start === from && selection.headAffinity !== "upstream" ||
        start === to && selection.headAffinity === "upstream";
}

function scrollSelectionHeadIntoView(head: DomPoint): void {
    const editor = getElement<HTMLElement>("editor");
    const range = document.createRange();
    range.setStart(head.node, head.offset);
    range.collapse(true);
    let rect = range.getClientRects()[0];
    if (!rect || rect.height === 0) {
        const element = head.node instanceof HTMLElement ? head.node : head.node.parentElement;
        rect = element?.getBoundingClientRect() as DOMRect;
    }
    if (!rect) return;
    // Scroll only the editor's own containers, including a split-view source
    // pane. Never let focus or scrollIntoView move the window or PDF pane.
    for (let parent: HTMLElement | null = editor; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const vertical = /auto|scroll/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight;
        const horizontal = /auto|scroll/.test(style.overflowX) && parent.scrollWidth > parent.clientWidth;
        if (!vertical && !horizontal) {
            if (parent.classList.contains("editor-shell")) break;
            continue;
        }
        const bounds = parent.getBoundingClientRect();
        const scaleY = parent.offsetHeight ? bounds.height / parent.offsetHeight : 1;
        const scaleX = parent.offsetWidth ? bounds.width / parent.offsetWidth : 1;
        const top = bounds.top + parent.clientTop * scaleY + 8;
        const bottom = bounds.top + (parent.clientTop + parent.clientHeight) * scaleY - 8;
        const left = bounds.left + parent.clientLeft * scaleX + 8;
        const right = bounds.left + (parent.clientLeft + parent.clientWidth) * scaleX - 8;
        const dy = vertical ? rect.top < top ? rect.top - top : rect.bottom > bottom ? rect.bottom - bottom : 0 : 0;
        const dx = horizontal ? rect.left < left ? rect.left - left : rect.right > right ? rect.right - right : 0 : 0;
        parent.scrollTop += dy / scaleY;
        parent.scrollLeft += dx / scaleX;
        rect = new DOMRect(rect.x - dx, rect.y - dy, rect.width, rect.height);
        if (parent.classList.contains("editor-shell")) break;
    }
}
