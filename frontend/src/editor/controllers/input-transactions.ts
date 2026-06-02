export type BeforeInputUndoKind = "typing" | "discrete" | "history-undo" | "history-redo" | null;

export function readBeforeInputUndoKind(event: InputEvent, isComposingText: boolean): BeforeInputUndoKind {
    if (event.inputType === "historyUndo") {
        return "history-undo";
    }

    if (event.inputType === "historyRedo") {
        return "history-redo";
    }

    if (isComposingText) {
        return null;
    }

    if (event.inputType === "insertText" || event.inputType === "insertCompositionText") {
        return "typing";
    }

    if (event.inputType.startsWith("delete")) {
        return "typing";
    }

    if (
        event.inputType === "insertFromDrop" ||
        event.inputType === "insertReplacementText" ||
        event.inputType.startsWith("format") ||
        event.inputType.startsWith("insert")
    ) {
        return "discrete";
    }

    return null;
}

export function shouldEndTypingBatchAfterInput(event: InputEvent): boolean {
    if (event.inputType !== "insertText" || event.data === null) {
        return false;
    }

    return /[\s.,;:!?()[\]{}"'`]/.test(event.data);
}

export function isTypingBoundaryKeydown(event: KeyboardEvent): boolean {
    if (event.ctrlKey || event.metaKey || event.altKey) {
        return false;
    }

    return (
        event.key.startsWith("Arrow") ||
        event.key === "Home" ||
        event.key === "End" ||
        event.key === "PageUp" ||
        event.key === "PageDown" ||
        event.key === "Escape"
    );
}
