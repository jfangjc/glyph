import { buildBlockIndex } from "./block-index";
import { applyTransactionToDoc, normalizeSelection } from "./transaction";
import type {
    EditorSnapshot,
    EditorState,
    EditorStateListener,
    SelectionRange,
    Transaction,
} from "./types";

type HistoryEntry = {
    before: EditorSnapshot;
    after: EditorSnapshot;
};

const maxHistoryEntries = 100;

let editorState = freezeEditorState({
    doc: "",
    selection: { anchor: 0, head: 0 },
    blocks: buildBlockIndex(""),
    revision: 0,
});
let listeners: EditorStateListener[] = [];
let undoStack: HistoryEntry[] = [];
let redoStack: HistoryEntry[] = [];
let isRestoringHistory = false;
let isNotifying = false;
let queuedTransactions: Transaction[] = [];

export function getEditorState(): EditorState {
    return editorState;
}

export function getMarkdownSource(): string {
    return editorState.doc;
}

export function replaceDocumentSource(
    source: string,
    selection: SelectionRange = { anchor: 0, head: 0 },
    annotation: Transaction["annotations"] = { userEvent: "programmatic", addToHistory: false },
): void {
    dispatch({
        changes: [{ from: 0, to: editorState.doc.length, insert: source }],
        selection,
        annotations: annotation,
    });
}

export function dispatch(transaction: Transaction): void {
    if (isNotifying) {
        queuedTransactions.push(transaction);
        return;
    }

    applyDispatch(transaction);
    flushQueuedTransactions();
}

export function subscribeEditorState(listener: EditorStateListener): () => void {
    listeners = [...listeners, listener];
    return () => {
        listeners = listeners.filter((candidate) => candidate !== listener);
    };
}

export function clearSourceHistory(): void {
    undoStack = [];
    redoStack = [];
}

export function undoSourceHistory(): boolean {
    const entry = undoStack.pop();
    if (!entry) {
        return false;
    }

    isRestoringHistory = true;
    try {
        restoreSnapshot(entry.before);
        redoStack.push(entry);
    } finally {
        isRestoringHistory = false;
    }
    return true;
}

export function redoSourceHistory(): boolean {
    const entry = redoStack.pop();
    if (!entry) {
        return false;
    }

    isRestoringHistory = true;
    try {
        restoreSnapshot(entry.after);
        undoStack.push(entry);
    } finally {
        isRestoringHistory = false;
    }
    return true;
}

function applyDispatch(transaction: Transaction): void {
    const previous = editorState;
    const applied = applyTransactionToDoc(previous.doc, previous.selection, transaction);
    const normalizedTransaction = { ...transaction, changes: applied.changes };
    const nextDocChanged = applied.doc !== previous.doc;
    const nextSelection = normalizeSelection(applied.selection, applied.doc.length);
    const next = freezeEditorState({
        doc: applied.doc,
        selection: nextSelection,
        blocks: buildBlockIndex(applied.doc, previous.blocks),
        revision: previous.revision + 1,
    });

    if (shouldRecordHistory(normalizedTransaction, nextDocChanged)) {
        pushHistoryEntry({
            before: createSnapshot(previous),
            after: createSnapshot(next),
        });
    }

    editorState = next;
    notifySubscribers(next, previous, normalizedTransaction);
}

function restoreSnapshot(snapshot: EditorSnapshot): void {
    dispatch({
        changes: [{ from: 0, to: editorState.doc.length, insert: snapshot.doc }],
        selection: snapshot.selection,
        annotations: { userEvent: "history", addToHistory: false },
    });
}

function shouldRecordHistory(transaction: Transaction, docChanged: boolean): boolean {
    if (isRestoringHistory || !docChanged) {
        return false;
    }

    if (transaction.annotations?.addToHistory !== undefined) {
        return transaction.annotations.addToHistory;
    }

    return transaction.annotations?.userEvent !== "programmatic";
}

function pushHistoryEntry(entry: HistoryEntry): void {
    undoStack.push(entry);
    if (undoStack.length > maxHistoryEntries) {
        undoStack.shift();
    }
    redoStack = [];
}

function notifySubscribers(next: EditorState, previous: EditorState, transaction: Transaction): void {
    isNotifying = true;
    try {
        for (const listener of listeners) {
            listener(next, previous, transaction);
        }
    } finally {
        isNotifying = false;
    }
}

function flushQueuedTransactions(): void {
    while (!isNotifying && queuedTransactions.length > 0) {
        const nextTransaction = queuedTransactions.shift();
        if (nextTransaction) {
            applyDispatch(nextTransaction);
        }
    }
}

function createSnapshot(state: EditorState): EditorSnapshot {
    return {
        doc: state.doc,
        selection: state.selection,
    };
}

function freezeEditorState(state: EditorState): EditorState {
    const blocks = state.blocks.blocks.map((block) => Object.freeze({ ...block })) as unknown as typeof state.blocks.blocks;
    const blockIndex = Object.freeze({ blocks: Object.freeze(blocks) as unknown as typeof state.blocks.blocks });

    return Object.freeze({
        ...state,
        selection: Object.freeze({ ...state.selection }),
        blocks: blockIndex,
    });
}
