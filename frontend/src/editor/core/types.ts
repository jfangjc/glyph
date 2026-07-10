import type { ParsedBlock } from "../blocks/model";

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
