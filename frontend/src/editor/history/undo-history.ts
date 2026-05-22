import { getElement } from "../../utils/dom";
import { type ParsedBlock } from "../blocks/model";
import {
    createBlock,
    findBlock,
    getBlockContent,
    getEditorBlocks,
    getSerializableEditorBlocks,
    readEditorBlock,
    syncFirstBlockPlaceholder,
} from "../blocks/view";
import {
    focusBlockAtOffset,
    getCaretOffset,
    getSelectedBlockRange,
    getTextPosition,
} from "../selection/caret";

type SelectionPoint = {
    blockIndex: number;
    offset: number;
};

type SelectionSnapshot = {
    anchor: SelectionPoint;
    focus: SelectionPoint;
};

type EditorSnapshot = {
    title: string;
    blocks: ParsedBlock[];
    selection: SelectionSnapshot | null;
};

type HistoryEntry = {
    before: EditorSnapshot;
    after: EditorSnapshot;
};

type TransactionKind = "typing" | "discrete";

const maxHistoryEntries = 100;
const typingBatchDelayMs = 1200;

let undoStack: HistoryEntry[] = [];
let redoStack: HistoryEntry[] = [];
let pendingTransaction: { kind: TransactionKind; before: EditorSnapshot; after: EditorSnapshot | null } | null = null;
let typingBatchTimer: number | null = null;
let isRestoring = false;

export function clearEditorHistory(): void {
    clearTypingBatchTimer();
    pendingTransaction = null;
    undoStack = [];
    redoStack = [];
}

export function beginTypingUndoTransaction(): void {
    beginUndoTransaction("typing");
}

export function beginDiscreteUndoTransaction(): void {
    beginUndoTransaction("discrete");
}

export function commitUndoTransaction(): void {
    if (!pendingTransaction || isRestoring) {
        return;
    }

    const after = createEditorSnapshot();
    if (snapshotsHaveSameDocument(pendingTransaction.before, after)) {
        pendingTransaction = null;
        clearTypingBatchTimer();
        return;
    }

    if (pendingTransaction.kind === "typing") {
        pendingTransaction.after = after;
        scheduleTypingBatchCommit();
        return;
    }

    pushHistoryEntry({ before: pendingTransaction.before, after });
    pendingTransaction = null;
}

export function flushPendingUndoTransaction(): void {
    if (!pendingTransaction) {
        return;
    }

    clearTypingBatchTimer();
    if (pendingTransaction.after && !snapshotsHaveSameDocument(pendingTransaction.before, pendingTransaction.after)) {
        pushHistoryEntry({ before: pendingTransaction.before, after: pendingTransaction.after });
    }
    pendingTransaction = null;
}

export function undoEditorChange(): boolean {
    flushPendingUndoTransaction();
    const entry = undoStack.pop();
    if (!entry) {
        return false;
    }

    restoreEditorSnapshot(entry.before);
    redoStack.push(entry);
    return true;
}

export function redoEditorChange(): boolean {
    flushPendingUndoTransaction();
    const entry = redoStack.pop();
    if (!entry) {
        return false;
    }

    restoreEditorSnapshot(entry.after);
    undoStack.push(entry);
    return true;
}

function beginUndoTransaction(kind: TransactionKind): void {
    if (isRestoring) {
        return;
    }

    if (kind === "typing" && pendingTransaction?.kind === "typing") {
        clearTypingBatchTimer();
        return;
    }

    flushPendingUndoTransaction();
    pendingTransaction = {
        kind,
        before: createEditorSnapshot(),
        after: null,
    };
}

function pushHistoryEntry(entry: HistoryEntry): void {
    undoStack.push(entry);
    if (undoStack.length > maxHistoryEntries) {
        undoStack.shift();
    }
    redoStack = [];
}

function scheduleTypingBatchCommit(): void {
    clearTypingBatchTimer();
    typingBatchTimer = window.setTimeout(() => {
        flushPendingUndoTransaction();
    }, typingBatchDelayMs);
}

function clearTypingBatchTimer(): void {
    if (typingBatchTimer !== null) {
        window.clearTimeout(typingBatchTimer);
        typingBatchTimer = null;
    }
}

function createEditorSnapshot(): EditorSnapshot {
    const title = getElement<HTMLInputElement>("document-title");

    return {
        title: title.value,
        blocks: cloneBlocks(getSerializableEditorBlocks().map(readEditorBlock)),
        selection: readSelectionSnapshot(),
    };
}

function restoreEditorSnapshot(snapshot: EditorSnapshot): void {
    isRestoring = true;
    try {
        const title = getElement<HTMLInputElement>("document-title");
        const editor = getElement<HTMLElement>("editor");
        const nextBlocks = cloneBlocks(snapshot.blocks).map((block) => createBlock(block.type, block.text, block));

        title.value = snapshot.title;
        editor.replaceChildren(...nextBlocks);
        syncFirstBlockPlaceholder();
        restoreSelectionSnapshot(snapshot.selection);
    } finally {
        isRestoring = false;
    }
}

function readSelectionSnapshot(): SelectionSnapshot | null {
    const selectedRange = getSelectedBlockRange();
    if (selectedRange) {
        return {
            anchor: {
                blockIndex: getBlockIndex(selectedRange.startBlock),
                offset: selectedRange.startOffset,
            },
            focus: {
                blockIndex: getBlockIndex(selectedRange.endBlock),
                offset: selectedRange.endOffset,
            },
        };
    }

    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    const block = findBlock(focusNode ?? null);
    if (!selection?.isCollapsed || !focusNode || !block) {
        return null;
    }

    const offset = getCaretOffset(getBlockContent(block), focusNode, selection.focusOffset);
    const point = { blockIndex: getBlockIndex(block), offset };
    return { anchor: point, focus: point };
}

function restoreSelectionSnapshot(selectionSnapshot: SelectionSnapshot | null): void {
    const blocks = getEditorBlocks();
    if (blocks.length === 0) {
        return;
    }

    if (!selectionSnapshot) {
        focusBlockAtOffset(blocks[0], 0);
        return;
    }

    const anchorBlock = blocks[clampIndex(selectionSnapshot.anchor.blockIndex, blocks.length)];
    const focusBlock = blocks[clampIndex(selectionSnapshot.focus.blockIndex, blocks.length)];
    const anchor = getTextPosition(getBlockContent(anchorBlock), selectionSnapshot.anchor.offset);
    const focus = getTextPosition(getBlockContent(focusBlock), selectionSnapshot.focus.offset);
    const selection = document.getSelection();
    const range = document.createRange();

    range.setStart(anchor.node, anchor.offset);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);

    if (selection && (anchorBlock !== focusBlock || selectionSnapshot.anchor.offset !== selectionSnapshot.focus.offset)) {
        selection.extend(focus.node, focus.offset);
    }
}

function snapshotsHaveSameDocument(left: EditorSnapshot, right: EditorSnapshot): boolean {
    return left.title === right.title && JSON.stringify(left.blocks) === JSON.stringify(right.blocks);
}

function cloneBlocks(blocks: ParsedBlock[]): ParsedBlock[] {
    return blocks.map((block) => ({ ...block }));
}

function getBlockIndex(block: HTMLElement): number {
    return Math.max(0, getEditorBlocks().indexOf(block));
}

function clampIndex(index: number, length: number): number {
    return Math.max(0, Math.min(index, length - 1));
}
