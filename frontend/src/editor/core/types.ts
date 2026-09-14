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
    readVisualHiddenRanges?: (state: EditorState) => Array<{
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
