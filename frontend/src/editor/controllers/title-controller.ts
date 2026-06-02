import { syncDocumentWindowTitle } from "../../app/window-title";
import type { DocumentFormat } from "../../formats/types";
import {
    beginDiscreteUndoTransaction,
    beginTypingUndoTransaction,
    commitUndoTransaction,
    flushPendingUndoTransaction,
} from "../history/undo-history";
import { isRedoShortcut, isUndoShortcut } from "../input/keyboard-shortcuts";
import {
    isTypingBoundaryKeydown,
    readBeforeInputUndoKind,
    shouldEndTypingBatchAfterInput,
} from "./input-transactions";
import { redoHistoryChange, undoHistoryChange } from "./undo-controller";

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
    markDocumentDirty: () => void;
    saveDocument: () => Promise<boolean>;
    syncActiveBlockIndicator: (block: HTMLElement | null) => void;
    syncBlockSourceReveal: (block: HTMLElement | null) => void;
};

export function createTitleController(options: TitleControllerOptions): TitleController {
    let shouldFlushTypingBatchAfterInput = false;

    return {
        handleTitleBeforeInput,
        handleTitleKeydown,
        handleTitleInput,
        handleTitleFocus,
        handleTitleBlur,
    };

    function handleTitleBeforeInput(event: InputEvent): void {
        if (!options.getActiveDocumentFormat().supportsTitle) {
            return;
        }

        const undoKind = readBeforeInputUndoKind(event, options.isComposingText());
        if (undoKind === "history-undo" || undoKind === "history-redo") {
            event.preventDefault();
            if (undoKind === "history-undo") {
                undoHistoryChange();
            } else {
                redoHistoryChange();
            }
            return;
        }

        if (undoKind === "typing") {
            beginTypingUndoTransaction();
            shouldFlushTypingBatchAfterInput = shouldEndTypingBatchAfterInput(event);
        } else if (undoKind === "discrete") {
            beginDiscreteUndoTransaction();
            shouldFlushTypingBatchAfterInput = false;
        }
    }

    function handleTitleKeydown(event: KeyboardEvent): void {
        if (isUndoShortcut(event)) {
            event.preventDefault();
            undoHistoryChange();
            return;
        }

        if (isRedoShortcut(event)) {
            event.preventDefault();
            redoHistoryChange();
            return;
        }

        if (isTypingBoundaryKeydown(event)) {
            flushPendingUndoTransaction();
        }
    }

    function handleTitleInput(): void {
        if (!options.getActiveDocumentFormat().supportsTitle) {
            return;
        }

        commitUndoTransaction();
        flushTypingBatchAfterInputIfNeeded();
        syncDocumentWindowTitle();
        options.markDocumentDirty();
    }

    function handleTitleFocus(): void {
        flushPendingUndoTransaction();
        options.syncActiveBlockIndicator(null);
        options.syncBlockSourceReveal(null);
    }

    function handleTitleBlur(): void {
        flushPendingUndoTransaction();
        if (options.hasActiveFileWithUnsavedChanges()) {
            void options.saveDocument();
        }
    }

    function flushTypingBatchAfterInputIfNeeded(): void {
        if (!shouldFlushTypingBatchAfterInput) {
            return;
        }

        shouldFlushTypingBatchAfterInput = false;
        flushPendingUndoTransaction();
    }
}
