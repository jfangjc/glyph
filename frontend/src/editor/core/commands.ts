import {
    nextGraphemeBoundary,
    nextLineBoundary,
    nextWordBoundary,
    previousGraphemeBoundary,
    previousLineBoundary,
    previousWordBoundary,
} from "../../utils/text-boundaries";
import type { EditorState, Transaction } from "./types";

export type DeleteDirection = "backward" | "forward";
export type DeleteGranularity = "grapheme" | "word" | "soft-line" | "hard-line";

export function createInsertTextTransaction(state: EditorState, text: string): Transaction {
    return createReplaceSelectionTransaction(state, normalizeInsertedText(text), "input", "typing");
}

export function createPasteTransaction(state: EditorState, text: string): Transaction {
    return createReplaceSelectionTransaction(state, normalizeInsertedText(text), "paste", "discrete");
}

export function createDeleteTransaction(
    state: EditorState,
    direction: DeleteDirection,
    granularity: DeleteGranularity,
): Transaction | null {
    const range = orderedSelection(state);
    if (range.from !== range.to) {
        return createDeleteRangeTransaction(range.from, range.to);
    }

    const offset = range.from;
    const boundary = readDeleteBoundary(state.doc, offset, direction, granularity);
    if (boundary === offset) {
        return null;
    }

    return direction === "backward"
        ? createDeleteRangeTransaction(boundary, offset)
        : createDeleteRangeTransaction(offset, boundary);
}

function createReplaceSelectionTransaction(
    state: EditorState,
    insert: string,
    userEvent: "input" | "paste",
    historyMode: "typing" | "discrete",
): Transaction {
    const range = orderedSelection(state);
    const head = range.from + insert.length;
    return {
        changes: [{ from: range.from, to: range.to, insert }],
        selection: { anchor: head, head },
        annotations: { userEvent, historyMode },
    };
}

function createDeleteRangeTransaction(from: number, to: number): Transaction {
    return {
        changes: [{ from, to, insert: "" }],
        selection: { anchor: from, head: from },
        annotations: { userEvent: "delete", historyMode: "typing" },
    };
}

function readDeleteBoundary(
    doc: string,
    offset: number,
    direction: DeleteDirection,
    granularity: DeleteGranularity,
): number {
    if (direction === "backward") {
        if (granularity === "word") {
            return previousWordBoundary(doc, offset);
        }
        if (granularity === "soft-line" || granularity === "hard-line") {
            return previousLineBoundary(doc, offset);
        }
        return previousGraphemeBoundary(doc, offset);
    }

    if (granularity === "word") {
        return nextWordBoundary(doc, offset);
    }
    if (granularity === "soft-line" || granularity === "hard-line") {
        return nextLineBoundary(doc, offset);
    }
    return nextGraphemeBoundary(doc, offset);
}

function orderedSelection(state: EditorState): { from: number; to: number } {
    return {
        from: Math.min(state.selection.anchor, state.selection.head),
        to: Math.max(state.selection.anchor, state.selection.head),
    };
}

function normalizeInsertedText(text: string): string {
    return text.replace(/\r\n?/g, "\n");
}
