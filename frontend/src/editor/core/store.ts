import { applyTransactionToDoc, mapSelection, normalizeSelection } from "./transaction";
import type {
    BlockIndexBuilder,
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

export type MappedSelectionBookmark = {
    read: () => SelectionRange | null;
    dispose: () => void;
};

type MutableSelectionBookmark = {
    selection: SelectionRange;
    disposed: boolean;
};

const maxHistoryEntries = 100;
const typingBatchDelayMs = 1200;

let editorState = freezeEditorState({
    doc: "",
    selection: { anchor: 0, head: 0 },
    blocks: { blocks: [] },
    revision: 0,
});
let blockIndexBuilder: BlockIndexBuilder = () => ({ blocks: [] });
let blockIndexInvalidated = true;
let listeners: EditorStateListener[] = [];
let undoStack: HistoryEntry[] = [];
let redoStack: HistoryEntry[] = [];
let pendingTypingHistory: HistoryEntry | null = null;
let pendingTypingUserEvent: "input" | "delete" | null = null;
let typingBatchTimer: ReturnType<typeof setTimeout> | null = null;
const selectionBookmarks = new Set<MutableSelectionBookmark>();
let isRestoringHistory = false;
let isNotifying = false;
let queuedTransactions: Transaction[] = [];

export function getEditorState(): EditorState {
    return editorState;
}

export function getDocumentSource(): string {
    return editorState.doc;
}

export function configureBlockIndexBuilder(builder: BlockIndexBuilder): void {
    blockIndexBuilder = builder;
    blockIndexInvalidated = true;
}

export function replaceDocumentState(
    source: string,
    selection: SelectionRange = { anchor: 0, head: 0 },
): void {
    disposeAllSelectionBookmarks();
    flushSourceHistoryBatch();
    dispatch({
        changes: [{ from: 0, to: editorState.doc.length, insert: source }],
        selection,
        annotations: { userEvent: "programmatic", addToHistory: false },
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
    clearTypingBatchTimer();
    pendingTypingHistory = null;
    pendingTypingUserEvent = null;
    undoStack = [];
    redoStack = [];
}

export function rewriteSourceHistory(
    replacements: Array<{ source: string; replacement: string }>,
): void {
    if (replacements.length === 0) {
        return;
    }

    const rewriteEntry = (entry: HistoryEntry): HistoryEntry => ({
        before: rewriteSnapshot(entry.before, replacements),
        after: rewriteSnapshot(entry.after, replacements),
    });
    undoStack = undoStack.map(rewriteEntry);
    redoStack = redoStack.map(rewriteEntry);
    if (pendingTypingHistory) {
        pendingTypingHistory = rewriteEntry(pendingTypingHistory);
    }
}

export function flushSourceHistoryBatch(): void {
    clearTypingBatchTimer();
    if (!pendingTypingHistory) {
        return;
    }

    pushHistoryEntry(pendingTypingHistory, false);
    pendingTypingHistory = null;
    pendingTypingUserEvent = null;
}

export function createSelectionBookmark(selection: SelectionRange = editorState.selection): MappedSelectionBookmark {
    const bookmark: MutableSelectionBookmark = {
        selection: normalizeSelection(selection, editorState.doc.length),
        disposed: false,
    };
    selectionBookmarks.add(bookmark);

    return {
        read: () => bookmark.disposed ? null : { ...bookmark.selection },
        dispose: () => disposeSelectionBookmark(bookmark),
    };
}

export function undoSourceHistory(): boolean {
    flushSourceHistoryBatch();
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
    flushSourceHistoryBatch();
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
    const transactionStartedAt = readPerformanceNow();
    const previous = editorState;
    const applied = applyTransactionToDoc(previous.doc, previous.selection, transaction);
    const normalizedTransaction = { ...transaction, changes: applied.changes };
    const nextDocChanged = applied.doc !== previous.doc;
    const nextSelection = normalizeSelection(applied.selection, applied.doc.length);
    const blockIndexStartedAt = readPerformanceNow();
    const blocks = nextDocChanged || blockIndexInvalidated
        ? blockIndexBuilder(applied.doc, {
            previousDoc: previous.doc,
            previous: previous.blocks,
            changes: applied.changes,
        })
        : previous.blocks;
    blockIndexInvalidated = false;
    measureEditorPerformance("glyph:block-index", blockIndexStartedAt);
    const next = freezeEditorState({
        doc: applied.doc,
        selection: nextSelection,
        blocks,
        revision: previous.revision + 1,
    });

    mapSelectionBookmarks(applied.changes);

    if (shouldRecordHistory(normalizedTransaction, nextDocChanged)) {
        recordHistoryEntry({
            before: createSnapshot(previous),
            after: createSnapshot(next),
        }, normalizedTransaction);
    } else if (!nextDocChanged && !selectionsEqual(previous.selection, next.selection)) {
        flushSourceHistoryBatch();
    }

    editorState = next;
    notifySubscribers(next, previous, normalizedTransaction);
    measureEditorPerformance("glyph:transaction", transactionStartedAt);
}

export function readPerformanceNow(): number {
    return typeof performance === "undefined" ? 0 : performance.now();
}

export function measureEditorPerformance(name: string, startedAt: number): void {
    if (!import.meta.env.DEV || typeof performance === "undefined") {
        return;
    }
    performance.measure(name, { start: startedAt, end: performance.now() });
    if (performance.getEntriesByName(name).length > 100) {
        performance.clearMeasures(name);
    }
}

function restoreSnapshot(snapshot: EditorSnapshot): void {
    dispatch({
        changes: [{ from: 0, to: editorState.doc.length, insert: snapshot.doc }],
        selection: snapshot.selection,
        annotations: { userEvent: "history", addToHistory: false },
    });
}

function rewriteSnapshot(
    snapshot: EditorSnapshot,
    replacements: Array<{ source: string; replacement: string }>,
): EditorSnapshot {
    const changes: Array<{ from: number; to: number; insert: string }> = [];
    for (const { source, replacement } of replacements) {
        let from = snapshot.doc.indexOf(source);
        while (from >= 0) {
            changes.push({ from, to: from + source.length, insert: replacement });
            from = snapshot.doc.indexOf(source, from + source.length);
        }
    }
    if (changes.length === 0) {
        return snapshot;
    }

    const rewritten = applyTransactionToDoc(snapshot.doc, snapshot.selection, { changes });
    return { doc: rewritten.doc, selection: rewritten.selection };
}

function shouldRecordHistory(transaction: Transaction, stateChanged: boolean): boolean {
    if (isRestoringHistory || !stateChanged) {
        return false;
    }

    if (transaction.annotations?.addToHistory !== undefined) {
        return transaction.annotations.addToHistory;
    }

    return transaction.annotations?.userEvent !== "programmatic";
}

function recordHistoryEntry(entry: HistoryEntry, transaction: Transaction): void {
    if (transaction.annotations?.historyMode !== "typing") {
        flushSourceHistoryBatch();
        pushHistoryEntry(entry);
        return;
    }

    const userEvent = transaction.annotations?.userEvent === "delete" ? "delete" : "input";
    if (pendingTypingHistory && pendingTypingUserEvent !== userEvent) {
        flushSourceHistoryBatch();
    }

    if (pendingTypingHistory) {
        pendingTypingHistory.after = entry.after;
    } else {
        redoStack = [];
        pendingTypingHistory = entry;
        pendingTypingUserEvent = userEvent;
    }

    scheduleTypingBatchFlush();
    if (isTypingBoundaryTransaction(transaction)) {
        flushSourceHistoryBatch();
    }
}

function pushHistoryEntry(entry: HistoryEntry, clearRedo = true): void {
    undoStack.push(entry);
    if (undoStack.length > maxHistoryEntries) {
        undoStack.shift();
    }
    if (clearRedo) {
        redoStack = [];
    }
}

function scheduleTypingBatchFlush(): void {
    clearTypingBatchTimer();
    typingBatchTimer = setTimeout(flushSourceHistoryBatch, typingBatchDelayMs);
}

function clearTypingBatchTimer(): void {
    if (typingBatchTimer !== null) {
        clearTimeout(typingBatchTimer);
        typingBatchTimer = null;
    }
}

function isTypingBoundaryTransaction(transaction: Transaction): boolean {
    return transaction.changes.some((change) => change.insert !== "" && /[\s\p{P}]/u.test(change.insert));
}

function mapSelectionBookmarks(changes: Transaction["changes"]): void {
    if (changes.length === 0) {
        return;
    }

    for (const bookmark of selectionBookmarks) {
        bookmark.selection = mapSelection(bookmark.selection, changes);
    }
}

function disposeSelectionBookmark(bookmark: MutableSelectionBookmark): void {
    bookmark.disposed = true;
    selectionBookmarks.delete(bookmark);
}

function disposeAllSelectionBookmarks(): void {
    for (const bookmark of selectionBookmarks) {
        bookmark.disposed = true;
    }
    selectionBookmarks.clear();
}

function selectionsEqual(left: SelectionRange, right: SelectionRange): boolean {
    return (
        left.anchor === right.anchor &&
        left.head === right.head &&
        left.anchorAffinity === right.anchorAffinity &&
        left.headAffinity === right.headAffinity
    );
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
