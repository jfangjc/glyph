import { syncEditorDirtyState } from "../../documents/document-session";
import {
    beginDiscreteUndoTransaction,
    commitUndoTransaction,
    redoEditorChange,
    undoEditorChange,
} from "../history/undo-history";

export function undoHistoryChange(): void {
    if (undoEditorChange()) {
        syncEditorDirtyState();
    }
}

export function redoHistoryChange(): void {
    if (redoEditorChange()) {
        syncEditorDirtyState();
    }
}

export function runDiscreteEdit(edit: () => void): void {
    beginDiscreteUndoTransaction();
    try {
        edit();
    } finally {
        commitUndoTransaction();
    }
}
