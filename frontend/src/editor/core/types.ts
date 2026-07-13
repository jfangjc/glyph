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

export type SelectionRange = {
    anchor: DocOffset;
    head: DocOffset;
};

export type Change = {
    from: DocOffset;
    to: DocOffset;
    insert: string;
};

export type Transaction = {
    changes: Change[];
    selection?: SelectionRange;
    title?: string;
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
    resolvePointerSourceOffset?: (source: string, target: Element, clientX: number) => number | null;
    reconcileInteractiveSource?: () => void;
};

export type EditorState = {
    doc: string;
    title: string;
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
    title: string;
    selection: SelectionRange;
};

export function findSourceBlockAtOffset(index: BlockIndex, offset: number): SourceBlock | null {
    if (index.blocks.length === 0) {
        return null;
    }
    const containing = index.blocks.find((block) => offset >= block.sourceFrom && offset <= block.sourceTo);
    if (containing) {
        return containing;
    }
    const nextIndex = index.blocks.findIndex((block) => offset < block.sourceFrom);
    return nextIndex < 0
        ? index.blocks[index.blocks.length - 1]
        : index.blocks[Math.max(0, nextIndex - 1)];
}

export function readVisibleListPrefixLength(block: SourceBlock): number {
    if (block.type === "ordered-list") {
        return `${block.listNumber ?? "1"}. `.length;
    }
    if (block.type === "todo") {
        return `${block.listMarker ?? "-"} [${block.checked ? "x" : " "}] `.length;
    }
    return `${block.listMarker ?? "-"} `.length;
}
