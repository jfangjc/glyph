import type { ParsedBlock } from "../blocks/model";

export type DocOffset = number;

export type SourceAffinity = "upstream" | "downstream";

/**
 * Describes which projection owns the selection. Source offsets are always the
 * canonical coordinates; the domain controls whether normally-hidden markup is
 * exposed while those coordinates are edited.
 */
export type SelectionRange = {
    anchor: DocOffset;
    head: DocOffset;
    anchorAffinity?: SourceAffinity;
    headAffinity?: SourceAffinity;
    source?: boolean;
};

export function isSourceSelection(selection: SelectionRange): boolean {
    return selection.source === true;
}

export type Change = {
    from: DocOffset;
    to: DocOffset;
    insert: string;
};

export type Transaction = {
    changes: Change[];
    selection?: SelectionRange;
    annotations?: {
        userEvent?: "input" | "delete" | "paste" | "format" | "history" | "programmatic";
        addToHistory?: boolean;
        historyMode?: "typing" | "discrete";
        typingBoundary?: boolean;
    };
};

export type SourceBlock = ParsedBlock & {
    id: string;
    sourceFrom: DocOffset;
    sourceTo: DocOffset;
    contentFrom: DocOffset;
    contentTo: DocOffset;
    lineFrom: number;
    lineTo: number;
};

export type BlockIndex = {
    blocks: SourceBlock[];
};

export type BlockIndexBuildContext = {
    previousDoc: string;
    previous: BlockIndex;
    changes: Change[];
};

export type BlockIndexBuilder = (doc: string, context?: BlockIndexBuildContext) => BlockIndex;

export type ProjectionCapability = {
    resolveSelectionRange?: (state: EditorState) => { from: DocOffset; to: DocOffset } | null;
    shouldUseNativePointer?: (target: Element) => boolean | null;
    readVisualHiddenRanges?: (state: EditorState, range?: { from: number; to: number }) => Array<{
        from: DocOffset;
        to: DocOffset;
        visibleFrom: DocOffset;
        visibleTo: DocOffset;
        atomic?: boolean;
    }>;
};

export type EditorState = {
    doc: string;
    selection: SelectionRange;
    blocks: BlockIndex;
    revision: number;
};

export type EditorStateListener = (
    next: EditorState,
    previous: EditorState,
    transaction: Transaction,
) => void;

export type EditorSnapshot = {
    doc: string;
    selection: SelectionRange;
};

export function findSourceBlockAtOffset(
    index: BlockIndex,
    offset: number,
    affinity: "upstream" | "downstream" = "downstream",
): SourceBlock | null {
    if (index.blocks.length === 0) {
        return null;
    }

    let low = 0;
    let high = index.blocks.length - 1;
    let candidateIndex = 0;
    while (low <= high) {
        const middle = (low + high) >>> 1;
        if (index.blocks[middle].sourceFrom <= offset) {
            candidateIndex = middle;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }

    const candidate = index.blocks[candidateIndex];
    const next = index.blocks[candidateIndex + 1];
    const previous = index.blocks[candidateIndex - 1];
    if (affinity === "upstream" && previous && offset === candidate.sourceFrom && previous.sourceTo === offset) {
        return previous;
    }
    if (
        affinity === "downstream" &&
        next &&
        offset === candidate.sourceTo &&
        offset === next.sourceFrom
    ) {
        return next;
    }
    if (offset >= candidate.sourceFrom && offset <= candidate.sourceTo) {
        return candidate;
    }
    return next && offset >= next.sourceFrom ? next : candidate;
}

export function readVisibleListPrefixLength(block: SourceBlock): number {
    if (block.type === "ordered-list") {
        return `${block.listNumber ?? "1"}${block.listDelimiter ?? "."} `.length;
    }
    if (block.type === "todo") {
        return `${block.listMarker ?? "-"} ${block.todoMarker ?? (block.checked ? "[x]" : "[ ]")} `.length;
    }
    return `${block.listMarker ?? "-"} `.length;
}

/** Only blocks intersecting the canonical source range, in source order. */
export function* sourceBlocksInRange(index: BlockIndex, from: number, to: number): Generator<SourceBlock> {
    let low = 0, high = index.blocks.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (index.blocks[middle].sourceTo < from) low = middle + 1;
        else high = middle;
    }
    for (let i = low; i < index.blocks.length && index.blocks[i].sourceFrom <= to; i += 1) {
        yield index.blocks[i];
    }
}

/** Separators have no live-preview caret host; source and revealed syntax do. */
export function resolveVisibleSourceOffset(index: BlockIndex, offset: number, direction: "backward" | "forward"): number {
    let low = 0, high = index.blocks.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (index.blocks[middle].sourceFrom <= offset) low = middle + 1;
        else high = middle;
    }
    const previous = index.blocks[low - 1];
    const next = index.blocks[low];
    if (previous && offset <= previous.sourceTo) return offset;
    return direction === "forward"
        ? next?.sourceFrom ?? previous?.sourceTo ?? offset
        : previous?.sourceTo ?? next?.sourceFrom ?? offset;
}

/** Left enters a list marker only after reaching the start of its body. */
export function resolveListNavigationAffinity(state: EditorState, target: number, affinity: SourceAffinity): SourceAffinity {
    const block = findSourceBlockAtOffset(state.blocks, target);
    if (!block || !["list", "ordered-list", "todo"].includes(block.type)) return affinity;
    // The first source character belongs to this item even when approached
    // from the right. Upstream ownership here would hide the entire marker.
    if (target === block.sourceFrom) return "downstream";
    // Arriving at the text's start from inside the body is still a body stop.
    // The next Left moves into the prefix and reveals it character by character.
    if (target === block.contentFrom && state.selection.head > target) return "downstream";
    return affinity;
}
