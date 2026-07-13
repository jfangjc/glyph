import { matchesShortcutCommand } from "../../app/keymap";
import { syncDocumentWindowTitle } from "../../app/window-title";
import type { DocumentFormat } from "../../formats/types";
import { getElement } from "../../utils/dom";
import {
    dispatch,
    flushSourceHistoryBatch,
    getEditorState,
    redoSourceHistory,
    undoSourceHistory,
} from "../core/store";

export type TitleController = {
    handleTitleBeforeInput: (event: InputEvent) => void;
    handleTitleKeydown: (event: KeyboardEvent) => void;
    handleTitleInput: () => void;
    handleTitleFocus: () => void;
    handleTitleBlur: () => void;
};

type TitleControllerOptions = {
    getActiveDocumentFormat: () => DocumentFormat;
    isComposingText: () => boolean;
    hasActiveFileWithUnsavedChanges: () => boolean;
    saveDocument: () => Promise<boolean>;
    syncActiveBlockIndicator: (block: HTMLElement | null) => void;
    syncBlockSourceReveal: (block: HTMLElement | null) => void;
};

export function createTitleController(options: TitleControllerOptions): TitleController {
    let historyMode: "typing" | "discrete" = "typing";
    let flushAfterInput = false;

    return {
        handleTitleBeforeInput,
        handleTitleKeydown,
        handleTitleInput,
        handleTitleFocus,
        handleTitleBlur,
    };

    function handleTitleBeforeInput(event: InputEvent): void {
        if (!options.getActiveDocumentFormat().descriptor.editableTitle) {
            return;
        }
        if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
            event.preventDefault();
            restoreHistory(event.inputType === "historyUndo" ? "undo" : "redo");
            return;
        }

        historyMode = isTypingInput(event, options.isComposingText()) ? "typing" : "discrete";
        flushAfterInput = event.inputType === "insertText" && Boolean(event.data && /[\s.,;:!?()[\]{}"'`]/.test(event.data));
    }

    function handleTitleKeydown(event: KeyboardEvent): void {
        if (matchesShortcutCommand(event, "edit:undo", "title")) {
            event.preventDefault();
            restoreHistory("undo");
            return;
        }
        if (matchesShortcutCommand(event, "edit:redo", "title")) {
            event.preventDefault();
            restoreHistory("redo");
            return;
        }
        if (isNavigationKey(event)) {
            flushSourceHistoryBatch();
        }
    }

    function handleTitleInput(): void {
        if (!options.getActiveDocumentFormat().descriptor.editableTitle) {
            return;
        }

        const title = getElement<HTMLInputElement>("document-title").value;
        dispatch({
            changes: [],
            title,
            annotations: {
                userEvent: "input",
                historyMode,
            },
        });
        if (flushAfterInput || historyMode === "discrete") {
            flushAfterInput = false;
            flushSourceHistoryBatch();
        }
        syncDocumentWindowTitle();
    }

    function handleTitleFocus(): void {
        flushSourceHistoryBatch();
        options.syncActiveBlockIndicator(null);
        options.syncBlockSourceReveal(null);
    }

    function handleTitleBlur(): void {
        flushSourceHistoryBatch();
        if (options.hasActiveFileWithUnsavedChanges()) {
            void options.saveDocument();
        }
    }

    function restoreHistory(direction: "undo" | "redo"): void {
        if (direction === "undo") {
            undoSourceHistory();
        } else {
            redoSourceHistory();
        }
        getElement<HTMLInputElement>("document-title").value = getEditorState().title;
        syncDocumentWindowTitle();
    }
}

function isTypingInput(event: InputEvent, isComposing: boolean): boolean {
    return isComposing || event.inputType === "insertText" || event.inputType.startsWith("delete");
}

function isNavigationKey(event: KeyboardEvent): boolean {
    return !event.ctrlKey && !event.metaKey && !event.altKey && (
        event.key.startsWith("Arrow") ||
        event.key === "Home" ||
        event.key === "End" ||
        event.key === "PageUp" ||
        event.key === "PageDown" ||
        event.key === "Escape"
    );
}
