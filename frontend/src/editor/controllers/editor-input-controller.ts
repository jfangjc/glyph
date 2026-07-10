import { getSuggestedFileName } from "../../app/window-title";
import { savePastedImage } from "../../bridge/documents";
import {
    matchesShortcutCommand,
    readInlineFormatShortcut,
} from "../../app/keymap";
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
    createCheckboxToggleTransaction,
    createCutTransaction,
    createDeleteBackwardTransaction,
    createDeleteForwardTransaction,
    createEnterTransaction,
    createIndentListTransaction,
    createInlineFormatTransaction,
    createInsertTextTransaction,
    createPasteTransaction,
    readSelectedSourceText,
} from "../core/commands";
import {
    createSelectionBookmark,
    dispatch,
    flushSourceHistoryBatch,
    getEditorState,
    redoSourceHistory,
    undoSourceHistory,
} from "../core/store";
import {
    domPointToSourceOffset,
    moveSourceSelectionVertically,
    resetVerticalNavigationAffinity,
    syncDomSelectionFromState,
    syncStateSelectionFromDom,
} from "../core/projection";
import { reportEditorError } from "../editor-status";
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
    readDataTransferText,
} from "../input/editor-clipboard";
import {
    handleEditorBeforeInput as handleEditorBeforeInputCommand,
    handleEditorInput as handleEditorInputCommand,
} from "../input/editor-input";
import { handleEditorKeydown as handleEditorKeydownCommand } from "../input/editor-keydown";
import { isPlainTextKey } from "../input/keyboard-events";
import { handleEditorMouseDown as handleEditorMouseDownCommand } from "../pointer-interactions";
import {
    getCaretPositionFromPoint,
    getSelectedBlockRange,
} from "../selection/caret";
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

const supportedPastedImageMimeTypes = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

export type EditorInputController = {
    deactivate: () => void;
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
    let preCompositionSourceSelection = getEditorState().selection;

    return {
        deactivate,
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

    function deactivate(): void {
        flushPendingUndoTransaction();
        flushSourceHistoryBatch();
        resetVerticalNavigationAffinity();
        options.getActiveDocumentFormat().editorBehavior?.deactivate?.(createDocumentEditorEventContext());
    }

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
        resetVerticalNavigationAffinity();
        const target = event.target;
        if (isSourceFirstMarkdown()) {
            flushPendingUndoTransaction();
            flushSourceHistoryBatch();
        } else if (target instanceof HTMLInputElement && target.classList.contains("todo-checkbox")) {
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
        if (isSourceFirstMarkdown() && target instanceof HTMLInputElement && target.classList.contains("todo-checkbox")) {
            const block = findBlock(target);
            const blockId = block?.dataset.blockId;
            const transaction = blockId ? createCheckboxToggleTransaction(getEditorState(), blockId) : null;
            if (transaction) {
                dispatch(transaction);
            }
            return;
        }

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
        if (matchesShortcutCommand(event, "edit:undo", "editor")) {
            event.preventDefault();
            if (isSourceFirstMarkdown()) {
                undoSourceHistory();
            } else {
                undoHistoryChange();
            }
            return;
        }

        if (matchesShortcutCommand(event, "edit:redo", "editor")) {
            event.preventDefault();
            if (isSourceFirstMarkdown()) {
                redoSourceHistory();
            } else {
                redoHistoryChange();
            }
            return;
        }

        if (isSourceFirstMarkdown() && handleSourceFirstMarkdownKeydown(event)) {
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
            if (isSourceFirstMarkdown()) {
                if (undoKind === "history-undo") {
                    undoSourceHistory();
                } else {
                    redoSourceHistory();
                }
            } else {
                if (undoKind === "history-undo") {
                    undoHistoryChange();
                } else {
                    redoHistoryChange();
                }
            }
            return;
        }

        if (isSourceFirstMarkdown() && handleSourceFirstMarkdownBeforeInput(event)) {
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
        if (isSourceFirstMarkdown()) {
            syncStateSelectionFromDom();
            preCompositionSourceSelection = getEditorState().selection;
        } else {
            beginTypingUndoTransaction();
        }
    }

    function handleEditorCompositionEnd(event: CompositionEvent): void {
        isComposingText = false;
        if (isSourceFirstMarkdown()) {
            const insert = event.data ?? "";
            if (insert) {
                dispatch({
                    changes: [{
                        from: Math.min(preCompositionSourceSelection.anchor, preCompositionSourceSelection.head),
                        to: Math.max(preCompositionSourceSelection.anchor, preCompositionSourceSelection.head),
                        insert,
                    }],
                    selection: {
                        anchor: Math.min(preCompositionSourceSelection.anchor, preCompositionSourceSelection.head) + insert.length,
                        head: Math.min(preCompositionSourceSelection.anchor, preCompositionSourceSelection.head) + insert.length,
                    },
                    annotations: { userEvent: "input" },
                });
            } else {
                syncDomSelectionFromState();
            }
            return;
        }

        handleEditorInput(event);
    }

    function handleEditorInput(event: Event): void {
        if (isSourceFirstMarkdown()) {
            return;
        }

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
        if (isSourceFirstMarkdown() && handleSourceFirstMarkdownCopy(event)) {
            return;
        }

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
        if (isSourceFirstMarkdown() && handleSourceFirstMarkdownCut(event)) {
            return;
        }

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
        if (isSourceFirstMarkdown() && handleSourceFirstMarkdownPaste(event)) {
            return;
        }

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
        if (isSourceFirstMarkdown() && handleSourceFirstMarkdownDrop(event)) {
            return;
        }

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

    function handleSourceFirstMarkdownKeydown(event: KeyboardEvent): boolean {
        if (isComposingText) {
            return true;
        }

        // Let beforeinput perform source-first range edits. The legacy Markdown
        // keydown handler mutates DOM ranges directly, while handling deletion
        // here can race selection projection; both leave EditorState out of sync.
        if (
            getSelectedBlockRange() &&
            (isPlainTextKey(event) || event.key === "Backspace" || event.key === "Delete")
        ) {
            return true;
        }

        if (matchesShortcutCommand(event, "edit:select-all", "markdown")) {
            event.preventDefault();
            dispatch({
                changes: [],
                selection: { anchor: 0, head: getEditorState().doc.length },
                annotations: { userEvent: "programmatic", addToHistory: false },
            });
            syncDomSelectionFromState();
            return true;
        }

        const inlineFormat = readInlineFormatShortcut(event, "markdown");
        if (inlineFormat) {
            event.preventDefault();
            syncStateSelectionFromDom();
            const transaction = createInlineFormatTransaction(getEditorState(), inlineFormat === "bold" ? "**" : "*");
            if (transaction) {
                dispatch(transaction);
            }
            return true;
        }

        if (event.key === "Enter") {
            event.preventDefault();
            syncStateSelectionFromDom();
            dispatch(createEnterTransaction(getEditorState()));
            return true;
        }

        if (event.key === "Tab") {
            syncStateSelectionFromDom();
            const transaction = createIndentListTransaction(getEditorState(), event.shiftKey ? -1 : 1);
            if (!transaction) {
                return false;
            }

            event.preventDefault();
            dispatch(transaction);
            return true;
        }

        if (event.key === "Backspace" || event.key === "Delete") {
            event.preventDefault();
            syncStateSelectionFromDom();
            const transaction = event.key === "Backspace"
                ? createDeleteBackwardTransaction(getEditorState())
                : createDeleteForwardTransaction(getEditorState());
            if (transaction) {
                dispatch(transaction);
            }
            return true;
        }

        if (isPlainVerticalNavigationKey(event)) {
            syncStateSelectionFromDom();
            if (moveSourceSelectionVertically(event.key === "ArrowUp" ? "up" : "down")) {
                event.preventDefault();
                return true;
            }
            return false;
        }

        return false;
    }

    function handleSourceFirstMarkdownBeforeInput(event: InputEvent): boolean {
        if (isComposingText) {
            return true;
        }

        const transaction = readSourceFirstBeforeInputTransaction(event);
        if (!transaction) {
            return false;
        }

        event.preventDefault();
        syncStateSelectionFromDom();
        const nextTransaction = transaction();
        if (nextTransaction) {
            dispatch(nextTransaction);
        }
        return true;
    }

    function readSourceFirstBeforeInputTransaction(event: InputEvent): (() => Parameters<typeof dispatch>[0] | null) | null {
        if (event.inputType === "insertText" && event.data !== null) {
            return () => createInsertTextTransaction(getEditorState(), event.data ?? "");
        }

        if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") {
            return () => createEnterTransaction(getEditorState());
        }

        if (event.inputType === "deleteContentBackward") {
            return () => createDeleteBackwardTransaction(getEditorState());
        }

        if (event.inputType === "deleteContentForward") {
            return () => createDeleteForwardTransaction(getEditorState());
        }

        return null;
    }

    function handleSourceFirstMarkdownCopy(event: ClipboardEvent): boolean {
        syncStateSelectionFromDom();
        const selectedText = readSelectedSourceText(getEditorState());
        if (selectedText === null || !event.clipboardData) {
            return false;
        }

        event.preventDefault();
        writeSourceClipboardText(event.clipboardData, selectedText);
        return true;
    }

    function handleSourceFirstMarkdownCut(event: ClipboardEvent): boolean {
        syncStateSelectionFromDom();
        const selectedText = readSelectedSourceText(getEditorState());
        const transaction = createCutTransaction(getEditorState());
        if (selectedText === null || !transaction || !event.clipboardData) {
            return false;
        }

        event.preventDefault();
        writeSourceClipboardText(event.clipboardData, selectedText);
        dispatch(transaction);
        return true;
    }

    function handleSourceFirstMarkdownPaste(event: ClipboardEvent): boolean {
        const text = readDataTransferText(event.clipboardData);
        if (!text) {
            const image = readClipboardImage(event.clipboardData);
            if (!image) {
                return false;
            }

            event.preventDefault();
            syncStateSelectionFromDom();
            void pasteSourceFirstMarkdownImage(image, createSelectionBookmark());
            return true;
        }

        event.preventDefault();
        pasteSourceText(text);
        return true;
    }

    function handleSourceFirstMarkdownDrop(event: DragEvent): boolean {
        const text = readDataTransferText(event.dataTransfer);
        const image = readClipboardImage(event.dataTransfer);
        if (!text && !image) {
            return false;
        }

        event.preventDefault();
        syncSourceSelectionFromDropPoint(event);
        if (text) {
            dispatch(createPasteTransaction(getEditorState(), text));
        } else if (image) {
            void pasteSourceFirstMarkdownImage(image, createSelectionBookmark());
        }

        return true;
    }

    async function pasteSourceFirstMarkdownImage(
        image: File,
        bookmark: ReturnType<typeof createSelectionBookmark>,
    ): Promise<void> {
        try {
            let activeFilePath = options.getActiveFilePath();
            if (!activeFilePath) {
                const saved = await options.ensureDocumentSaved({
                    promptForPath: true,
                    suggestedFileName: getSuggestedFileName(),
                });
                if (!saved) {
                    return;
                }

                activeFilePath = options.getActiveFilePath();
            }

            if (!activeFilePath) {
                return;
            }

            const dataUrl = await readFileAsDataUrl(image);
            const pastedImage = await savePastedImage(activeFilePath, dataUrl, image.name, image.type);
            const selection = bookmark.read();
            if (!selection) {
                return;
            }

            const state = getEditorState();
            dispatch(createPasteTransaction(
                { ...state, selection },
                `![${escapeMarkdownImageAlt(image.name)}](${pastedImage.relativePath})`,
            ));
        } catch (error) {
            console.error("Failed to paste image:", error);
            reportEditorError("Could not save the pasted image.");
        } finally {
            bookmark.dispose();
        }
    }

    function pasteSourceText(text: string): void {
        syncStateSelectionFromDom();
        dispatch(createPasteTransaction(getEditorState(), text));
    }

    function syncSourceSelectionFromDropPoint(event: DragEvent): void {
        const caretPosition = getCaretPositionFromPoint(event.clientX, event.clientY);
        if (!caretPosition) {
            syncStateSelectionFromDom();
            return;
        }

        const offset = domPointToSourceOffset(caretPosition.node, caretPosition.offset);
        dispatch({
            changes: [],
            selection: { anchor: offset, head: offset },
            annotations: { userEvent: "programmatic", addToHistory: false },
        });
    }

    function writeSourceClipboardText(clipboardData: DataTransfer, text: string): void {
        clipboardData.setData("text/plain", text);
        clipboardData.setData("text/markdown", text);
    }

    function isSourceFirstMarkdown(): boolean {
        return options.getActiveDocumentFormat().id === "markdown";
    }

    function isPlainVerticalNavigationKey(event: KeyboardEvent): boolean {
        return (
            (event.key === "ArrowUp" || event.key === "ArrowDown") &&
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.shiftKey
        );
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

function readClipboardImage(dataTransfer: DataTransfer | null | undefined): File | null {
    if (!dataTransfer) {
        return null;
    }

    for (const item of Array.from(dataTransfer.items)) {
        if (item.kind === "file" && supportedPastedImageMimeTypes.has(item.type.toLowerCase())) {
            return item.getAsFile();
        }
    }

    return Array.from(dataTransfer.files).find((file) => supportedPastedImageMimeTypes.has(file.type.toLowerCase())) ?? null;
}

function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => {
            if (typeof reader.result === "string") {
                resolve(reader.result);
            } else {
                reject(new Error("Unable to read image data"));
            }
        });
        reader.addEventListener("error", () => reject(reader.error ?? new Error("Unable to read image data")));
        reader.readAsDataURL(file);
    });
}

function escapeMarkdownImageAlt(value: string): string {
    return value.replace(/\.[^/.\\]+$/, "").replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}

function isTodoCheckboxActivation(event: KeyboardEvent): boolean {
    return (
        event.target instanceof HTMLInputElement &&
        event.target.classList.contains("todo-checkbox") &&
        (event.key === " " || event.key === "Enter")
    );
}
