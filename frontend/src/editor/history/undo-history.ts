import { getElement } from "../../utils/dom";
import { type ParsedBlock } from "../blocks/model";
import {
    createBlock,
    findBlock,
    getBlockIndex,
    getBlockContent,
    getEditorBlocks,
    getSerializableEditorBlocks,
    readEditorBlock,
} from "../blocks/view";
import {
    focusBlockSourceAtOffset,
    getBlockSourceElement,
    type BlockSourcePosition,
} from "../blocks/rendering";
import { focusMarkdownTokenSourceSelection } from "../../formats/markdown/editor/token-controller";
import {
    focusBlockAtOffset,
    getCaretOffset,
    readCurrentSourceSelectionTarget,
    getSelectedBlockRange,
    getTextPosition,
} from "../selection/caret";

type SelectionPoint = {
    blockIndex: number;
    offset: number;
};

type SelectionSnapshot =
    | {
          kind: "content";
          anchor: SelectionPoint;
          focus: SelectionPoint;
      }
    | {
          kind: "source";
          blockIndex: number;
          sourceKind: "block" | "inline";
          sourcePositionOrTokenIndex: BlockSourcePosition | number;
          offset: number;
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
        restoreSelectionSnapshot(snapshot.selection);
    } finally {
        isRestoring = false;
    }
}

function readSelectionSnapshot(): SelectionSnapshot | null {
    const selectedRange = getSelectedBlockRange();
    if (selectedRange) {
        return {
            kind: "content",
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

    const sourceTarget = readCurrentSourceSelectionTarget();
    if (sourceTarget) {
        if (sourceTarget.kind === "block-source") {
            return {
                kind: "source",
                blockIndex: getBlockIndex(sourceTarget.block),
                sourceKind: "block",
                sourcePositionOrTokenIndex: sourceTarget.sourcePosition,
                offset: sourceTarget.sourceOffset,
            };
        }

        return {
            kind: "source",
            blockIndex: getBlockIndex(sourceTarget.block),
            sourceKind: "inline",
            sourcePositionOrTokenIndex: getInlineTokenIndex(sourceTarget.block, sourceTarget.token),
            offset: sourceTarget.sourceOffset,
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
    return { kind: "content", anchor: point, focus: point };
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

    if (selectionSnapshot.kind === "source") {
        if (restoreSourceSelectionSnapshot(blocks, selectionSnapshot)) {
            return;
        }

        const fallbackBlock = blocks[clampIndex(selectionSnapshot.blockIndex, blocks.length)];
        focusBlockAtOffset(fallbackBlock, Math.min(selectionSnapshot.offset, getBlockContent(fallbackBlock).textContent?.length ?? 0));
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

function restoreSourceSelectionSnapshot(blocks: HTMLElement[], snapshot: Extract<SelectionSnapshot, { kind: "source" }>): boolean {
    const block = blocks[clampIndex(snapshot.blockIndex, blocks.length)];

    if (snapshot.sourceKind === "block") {
        const position = snapshot.sourcePositionOrTokenIndex;
        if (typeof position !== "string") {
            return false;
        }

        block.dataset.blockSourceActive = "true";
        const source = getBlockSourceElement(getBlockContent(block), position);
        if (!source) {
            return false;
        }

        focusBlockSourceAtOffset(source, Math.min(snapshot.offset, source.textContent?.length ?? 0));
        return true;
    }

    const tokenIndex = snapshot.sourcePositionOrTokenIndex;
    if (typeof tokenIndex !== "number" || tokenIndex < 0) {
        return false;
    }

    const token = getBlockContent(block).querySelectorAll<HTMLElement>(".markdown-token")[tokenIndex];
    if (!token) {
        return false;
    }

    return focusMarkdownTokenSourceSelection(token, snapshot.offset);
}

function getInlineTokenIndex(block: HTMLElement, token: HTMLElement): number {
    return Array.from(getBlockContent(block).querySelectorAll<HTMLElement>(".markdown-token")).indexOf(token);
}

function snapshotsHaveSameDocument(left: EditorSnapshot, right: EditorSnapshot): boolean {
    return left.title === right.title && JSON.stringify(left.blocks) === JSON.stringify(right.blocks);
}

function cloneBlocks(blocks: ParsedBlock[]): ParsedBlock[] {
    return blocks.map((block) => ({ ...block }));
}

function clampIndex(index: number, length: number): number {
    return Math.max(0, Math.min(index, length - 1));
}
