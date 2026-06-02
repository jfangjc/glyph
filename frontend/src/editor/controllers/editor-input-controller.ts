import { getSuggestedFileName } from "../../app/window-title";
import type {
    DocumentEditorEventContext,
    DocumentEditorHooks,
    DocumentFormat,
    DocumentPasteContext,
} from "../../formats/types";
import {
    findBlock,
    getBlockText,
    setBlockText,
} from "../blocks/view";
import {
    beginDiscreteUndoTransaction,
    beginTypingUndoTransaction,
    commitUndoTransaction,
    flushPendingUndoTransaction,
} from "../history/undo-history";
import {
    handleEditorCopy as handleEditorCopyCommand,
    handleEditorCut as handleEditorCutCommand,
    handleEditorDragOver as handleEditorDragOverCommand,
    handleEditorDrop as handleEditorDropCommand,
    handleEditorPaste as handleEditorPasteCommand,
} from "../input/editor-clipboard";
import {
    handleEditorBeforeInput as handleEditorBeforeInputCommand,
    handleEditorInput as handleEditorInputCommand,
} from "../input/editor-input";
import { handleEditorKeydown as handleEditorKeydownCommand } from "../input/editor-keydown";
import {
    isPlainTextKey,
    isRedoShortcut,
    isUndoShortcut,
    readInlineFormatShortcut,
} from "../input/keyboard-shortcuts";
import { handleEditorMouseDown as handleEditorMouseDownCommand } from "../pointer-interactions";
import { getSelectedBlockRange } from "../selection/caret";
import {
    isTypingBoundaryKeydown,
    readBeforeInputUndoKind,
    shouldEndTypingBatchAfterInput,
} from "./input-transactions";
import {
    redoHistoryChange,
    runDiscreteEdit,
    undoHistoryChange,
} from "./undo-controller";

export type EditorInputController = {
    handleEditorMouseDown: (event: MouseEvent) => void;
    handleEditorChange: (event: Event) => void;
    handleEditorKeydown: (event: KeyboardEvent) => void;
    handleEditorBeforeInput: (event: InputEvent) => void;
    handleEditorCompositionStart: () => void;
    handleEditorCompositionEnd: (event: CompositionEvent) => void;
    handleEditorInput: (event: Event) => void;
    handleEditorPaste: (event: ClipboardEvent) => void;
    handleEditorCopy: (event: ClipboardEvent) => void;
    handleEditorCut: (event: ClipboardEvent) => void;
    handleEditorDragOver: (event: DragEvent) => void;
    handleEditorDrop: (event: DragEvent) => void;
    handleEditorClick: (event: MouseEvent) => void;
    isComposingText: () => boolean;
};

type EditorInputControllerOptions = {
    hooks: DocumentEditorHooks;
    getActiveDocumentFormat: () => DocumentFormat;
    getActiveFilePath: () => string | null;
    ensureDocumentSaved: (options: { promptForPath: boolean; suggestedFileName: string }) => Promise<boolean>;
};

export function createEditorInputController(options: EditorInputControllerOptions): EditorInputController {
    let isComposingText = false;
    let shouldFlushTypingBatchAfterInput = false;

    return {
        handleEditorMouseDown,
        handleEditorChange,
        handleEditorKeydown,
        handleEditorBeforeInput,
        handleEditorCompositionStart,
        handleEditorCompositionEnd,
        handleEditorInput,
        handleEditorPaste,
        handleEditorCopy,
        handleEditorCut,
        handleEditorDragOver,
        handleEditorDrop,
        handleEditorClick,
        isComposingText: () => isComposingText,
    };

    function createDocumentEditorEventContext(): DocumentEditorEventContext {
        return {
            ...options.hooks,
            isComposingText,
        };
    }

    function createDocumentPasteContext(): DocumentPasteContext {
        return {
            ...createDocumentEditorEventContext(),
            getActiveDocumentFormat: options.getActiveDocumentFormat,
            getActiveFilePath: options.getActiveFilePath,
            ensureDocumentSaved: () =>
                options.ensureDocumentSaved({
                    promptForPath: true,
                    suggestedFileName: getSuggestedFileName(),
                }),
            runDiscreteEdit,
        };
    }

    function handleEditorMouseDown(event: MouseEvent): void {
        const target = event.target;
        if (target instanceof HTMLInputElement && target.classList.contains("todo-checkbox")) {
            beginDiscreteUndoTransaction();
        } else {
            flushPendingUndoTransaction();
        }

        const context = createDocumentEditorEventContext();
        const handledByFormat = options.getActiveDocumentFormat().editorBehavior?.mouseDown?.(event, context) ?? false;
        if (!handledByFormat) {
            handleEditorMouseDownCommand(event);
        }
    }

    function handleEditorChange(event: Event): void {
        const target = event.target;
        if (target instanceof HTMLInputElement && target.classList.contains("todo-checkbox")) {
            const block = findBlock(target);
            if (block) {
                setBlockText(block, getBlockText(block));
            }

            options.hooks.syncActiveBlockIndicator(block);
            options.hooks.syncBlockSourceReveal(block);
            commitUndoTransaction();
            options.hooks.markDocumentDirty();
        }
    }

    function handleEditorKeydown(event: KeyboardEvent): void {
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

        if (isTodoCheckboxActivation(event)) {
            beginDiscreteUndoTransaction();
            return;
        }

        if (isTypingBoundaryKeydown(event)) {
            flushPendingUndoTransaction();
        }

        const shouldTrackPlainTextSelectionReplacement = isPlainTextKey(event) && Boolean(getSelectedBlockRange());
        if (shouldTrackPlainTextSelectionReplacement) {
            beginTypingUndoTransaction();
        }

        const shouldTrackDiscreteEdit = !shouldTrackPlainTextSelectionReplacement && isDiscreteEditorKeydown(event);
        if (shouldTrackDiscreteEdit) {
            beginDiscreteUndoTransaction();
        }

        const context = createDocumentEditorEventContext();
        const handledByFormat = options.getActiveDocumentFormat().editorBehavior?.keydown?.(event, context) ?? false;
        if (!handledByFormat) {
            handleEditorKeydownCommand(event, context);
        }

        if (shouldTrackDiscreteEdit || shouldTrackPlainTextSelectionReplacement) {
            commitUndoTransaction();
        }
    }

    function handleEditorBeforeInput(event: InputEvent): void {
        const undoKind = readBeforeInputUndoKind(event, isComposingText);
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

        const context = createDocumentEditorEventContext();
        const handledByFormat = options.getActiveDocumentFormat().editorBehavior?.beforeInput?.(event, context) ?? false;
        if (!handledByFormat) {
            handleEditorBeforeInputCommand(event, context);
        }

        if (event.defaultPrevented && undoKind) {
            commitUndoTransaction();
            flushTypingBatchAfterInputIfNeeded();
        }
    }

    function handleEditorCompositionStart(): void {
        isComposingText = true;
        beginTypingUndoTransaction();
    }

    function handleEditorCompositionEnd(event: CompositionEvent): void {
        isComposingText = false;
        handleEditorInput(event);
    }

    function handleEditorInput(event: Event): void {
        const context = createDocumentEditorEventContext();
        const handledByFormat = options.getActiveDocumentFormat().editorBehavior?.input?.(event, context) ?? false;
        if (!handledByFormat) {
            handleEditorInputCommand(event, context);
        }
        commitUndoTransaction();
        flushTypingBatchAfterInputIfNeeded();
    }

    function handleEditorPaste(event: ClipboardEvent): void {
        handleEditorPasteFromFormatOrGeneric(event);
    }

    function handleEditorCopy(event: ClipboardEvent): void {
        const context = createDocumentEditorEventContext();
        const handledByFormat = options.getActiveDocumentFormat().editorBehavior?.copy?.(event, context) ?? false;
        if (handledByFormat) {
            return;
        }

        handleEditorCopyCommand(event, {
            getActiveDocumentFormat: options.getActiveDocumentFormat,
            markEditorDirty: options.hooks.markEditorDirty,
        });
    }

    function handleEditorCut(event: ClipboardEvent): void {
        runDiscreteEdit(() => {
            const context = createDocumentEditorEventContext();
            const handledByFormat = options.getActiveDocumentFormat().editorBehavior?.cut?.(event, context) ?? false;
            if (handledByFormat) {
                return;
            }

            handleEditorCutCommand(event, {
                getActiveDocumentFormat: options.getActiveDocumentFormat,
                markEditorDirty: options.hooks.markEditorDirty,
            });
        });
    }

    function handleEditorPasteFromFormatOrGeneric(event: ClipboardEvent): void {
        const context = createDocumentPasteContext();
        const handledByFormat = options.getActiveDocumentFormat().editorBehavior?.paste?.(event, context) ?? false;
        if (isPromiseLike(handledByFormat)) {
            void handledByFormat.then((handled) => {
                if (!handled) {
                    runGenericPaste(event);
                }
            });
            return;
        }

        if (handledByFormat) {
            return;
        }

        runGenericPaste(event);
    }

    function runGenericPaste(event: ClipboardEvent): void {
        runDiscreteEdit(() => {
            handleEditorPasteCommand(event, {
                getActiveDocumentFormat: options.getActiveDocumentFormat,
                markEditorDirty: options.hooks.markEditorDirty,
            });
        });
    }

    function handleEditorDragOver(event: DragEvent): void {
        handleEditorDragOverCommand(event);
    }

    function handleEditorDrop(event: DragEvent): void {
        handleEditorDropFromFormatOrGeneric(event);
    }

    function handleEditorDropFromFormatOrGeneric(event: DragEvent): void {
        const context = createDocumentPasteContext();
        const handledByFormat = options.getActiveDocumentFormat().editorBehavior?.drop?.(event, context) ?? false;
        if (isPromiseLike(handledByFormat)) {
            void handledByFormat.then((handled) => {
                if (!handled) {
                    runGenericDrop(event);
                }
            });
            return;
        }

        if (handledByFormat) {
            return;
        }

        runGenericDrop(event);
    }

    function runGenericDrop(event: DragEvent): void {
        runDiscreteEdit(() => {
            handleEditorDropCommand(event, {
                getActiveDocumentFormat: options.getActiveDocumentFormat,
                markEditorDirty: options.hooks.markEditorDirty,
            });
        });
    }

    function handleEditorClick(event: MouseEvent): void {
        options.getActiveDocumentFormat().editorBehavior?.click?.(event, createDocumentEditorEventContext());
    }

    function isDiscreteEditorKeydown(event: KeyboardEvent): boolean {
        if (isComposingText) {
            return false;
        }

        if (readInlineFormatShortcut(event)) {
            return true;
        }

        if (event.key === "Enter" || event.key === "Tab") {
            return true;
        }

        if ((event.key === "Backspace" || event.key === "Delete") && !event.ctrlKey && !event.metaKey && !event.altKey) {
            return true;
        }

        return false;
    }

    function flushTypingBatchAfterInputIfNeeded(): void {
        if (!shouldFlushTypingBatchAfterInput) {
            return;
        }

        shouldFlushTypingBatchAfterInput = false;
        flushPendingUndoTransaction();
    }
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
    return Boolean(value && typeof (value as Promise<T>).then === "function");
}

function isTodoCheckboxActivation(event: KeyboardEvent): boolean {
    return (
        event.target instanceof HTMLInputElement &&
        event.target.classList.contains("todo-checkbox") &&
        (event.key === " " || event.key === "Enter")
    );
}
