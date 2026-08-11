import type { ParsedBlock } from "../blocks/model";
import type { BlockSourcePosition } from "../blocks/rendering";

export type DocumentEditorHooks = {
    syncActiveBlockIndicator: (block: HTMLElement | null) => void;
    syncBlockSourceReveal: (block: HTMLElement | null) => void;
    syncBlockSourceRevealBlocks: (blocks: HTMLElement[]) => void;
};

export type DocumentSourceSelectionTarget =
    | {
          kind: "block-source";
          block: HTMLElement;
          source: HTMLElement;
          sourcePosition: BlockSourcePosition;
          sourceOffset: number;
      }
    | {
          kind: "inline-source";
          block: HTMLElement;
          token: HTMLElement;
          source: HTMLElement;
          sourceOffset: number;
      };

export type DocumentEditorSelectionState = {
    selection: Selection | null;
    isCollapsed: boolean;
    anchorNode: Node | null;
    focusNode: Node | null;
    anchorOffset: number;
    focusOffset: number;
    anchorBlock: HTMLElement | null;
    focusBlock: HTMLElement | null;
    anchorBlockOffset: number | null;
    focusBlockOffset: number | null;
    selectedBlocks: HTMLElement[];
    sourceTarget: DocumentSourceSelectionTarget | null;
};

export type DocOffset = number;

export type SourceAffinity = "upstream" | "downstream";

export type SelectionEndpoint = {
    offset: DocOffset;
    affinity: SourceAffinity;
};

export type SelectionRange = {
    anchor: DocOffset;
    head: DocOffset;
    anchorAffinity?: SourceAffinity;
    headAffinity?: SourceAffinity;
};

export function selectionEndpoint(
    selection: SelectionRange,
    endpoint: "anchor" | "head",
): SelectionEndpoint {
    return {
        offset: selection[endpoint],
        affinity: endpoint === "anchor"
            ? selection.anchorAffinity ?? "downstream"
            : selection.headAffinity ?? "downstream",
    };
}

export function orderedSelectionBounds(selection: SelectionRange): { from: DocOffset; to: DocOffset } {
    return {
        from: Math.min(selection.anchor, selection.head),
        to: Math.max(selection.anchor, selection.head),
    };
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
    sourceOffsetToDomPoint?: (offset: number) => { node: Node; offset: number } | null;
    domPointToSourceOffset?: (node: Node, offset: number) => number | null;
    shouldUseNativePointer?: (target: Element) => boolean | null;
    reconcileInteractiveSource?: () => void;
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
