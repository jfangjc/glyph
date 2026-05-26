import { getSuggestedFileName, syncDocumentWindowTitle } from "../app/window-title";
import { handleGlobalKeydown as handleGlobalKeydownCommand } from "../app/global-shortcuts";
import {
    bindDocumentActions,
    createNewMarkdownDocument,
    openDocumentPath,
    restoreLastOpenDocument,
    saveCurrentDocument,
    startDocumentAutosave,
} from "../documents/document-actions";
import { installFileTree, restoreLastOpenDirectory } from "../documents/file-tree";
import {
    documentState,
    documentStateChangedEvent,
    markDocumentDirty,
} from "../documents/document-state";
import {
    getActiveDocumentFormat,
    loadDocument,
    markEditorDirty,
    serializeDocument,
    syncBlockViewContext,
    syncDocumentFormatUi,
} from "../documents/document-session";
import { configureBlockOperations } from "./blocks/operations";
import {
    findBlock,
    getBlockText,
    setBlockText,
    syncFirstBlockPlaceholder,
} from "./blocks/view";
import { configureCaret } from "./selection/caret";
import { getElement } from "../utils/dom";
import {
    handleEditorCopy as handleEditorCopyCommand,
    handleEditorCut as handleEditorCutCommand,
    handleEditorPaste as handleEditorPasteCommand,
} from "./input/editor-clipboard";
import {
    handleEditorBeforeInput as handleEditorBeforeInputCommand,
    handleEditorInput as handleEditorInputCommand,
} from "./input/editor-input";
import {
    beginDiscreteUndoTransaction,
    beginTypingUndoTransaction,
    commitUndoTransaction,
    flushPendingUndoTransaction,
    redoEditorChange,
    undoEditorChange,
} from "./history/undo-history";
import { installEditorEventListeners } from "./editor-events";
import {
    installDocumentOutline,
    syncDocumentOutlineToBlock,
    syncDocumentOutlineToSelection,
} from "./document-outline";
import { handleEditorKeydown as handleEditorKeydownCommand } from "./input/editor-keydown";
import {
    isPlainTextKey,
    isRedoShortcut,
    isUndoShortcut,
    readInlineFormatShortcut,
} from "./input/keyboard-shortcuts";
import { getSelectedBlockRange } from "./selection/caret";
import {
    configureEditorUiState,
    syncActiveBlockIndicator,
    syncBlockSourceReveal,
    syncBlockSourceRevealBlocks,
} from "./editor-ui-state";
import {
    clearGutterHoverBlock,
    clearLinkOpenIntent,
    configurePointerInteractions,
    handleDocumentMouseMove,
    handleDocumentMouseUp,
    handleDocumentSurfaceMouseDown,
    handleDocumentSurfaceMouseMove,
    handleDocumentSurfaceMouseOut,
    handleDocumentSurfaceMouseOver,
    handleEditorMouseDown as handleEditorMouseDownCommand,
    syncLinkOpenIntentFromKeyboard,
} from "./pointer-interactions";
import {
    configureMarkdownTokenController,
    handleEditorClick,
    handleSelectionChange,
} from "../formats/markdown/editor/token-controller";
import {
    configureMarkdownSourceController,
    syncActiveBlockMarkdownSource,
} from "../formats/markdown/editor/source-controller";

let isComposingText = false;
let shouldFlushTypingBatchAfterInput = false;
let openDirectoryFromShortcut: (() => Promise<void>) | null = null;
let toggleFileTreeFromShortcut: (() => void) | null = null;

export function installEditorController(): void {
    const surface = getElement<HTMLElement>("document-surface");
    const editor = getElement<HTMLElement>("editor");
    const title = getElement<HTMLInputElement>("document-title");
    const shell = document.querySelector<HTMLElement>(".editor-shell");

    if (!shell) {
        throw new Error("Editor shell is missing");
    }

    installDocumentOutline(shell, editor);
    const fileTree = installFileTree(shell, {
        openDocumentPath,
    });
    openDirectoryFromShortcut = fileTree.openDirectory;
    toggleFileTreeFromShortcut = fileTree.toggle;
    installEditorEventListeners(
        { surface, editor, title },
        {
            onSurfaceMouseDown: handleDocumentSurfaceMouseDown,
            onSurfaceMouseMove: handleDocumentSurfaceMouseMove,
            onSurfaceMouseLeave: clearGutterHoverBlock,
            onSurfaceMouseOver: handleDocumentSurfaceMouseOver,
            onSurfaceMouseOut: handleDocumentSurfaceMouseOut,
            onDocumentMouseMove: handleDocumentMouseMove,
            onDocumentMouseUp: handleDocumentMouseUp,
            onEditorKeydown: handleEditorKeydown,
            onEditorMouseDown: handleEditorMouseDown,
            onEditorBeforeInput: handleEditorBeforeInput,
            onEditorInput: handleEditorInput,
            onEditorCopy: handleEditorCopy,
            onEditorCut: handleEditorCut,
            onEditorPaste: handleEditorPaste,
            onEditorChange: handleEditorChange,
            onEditorClick: handleEditorClick,
            onEditorCompositionStart: handleEditorCompositionStart,
            onEditorCompositionEnd: handleEditorCompositionEnd,
            onTitleInput: handleTitleInput,
            onTitleFocus: handleTitleFocus,
            onTitleBlur: handleTitleBlur,
            onSelectionChange: handleEditorSelectionChange,
            onWindowKeydown: handleGlobalKeydown,
            onWindowKeyup: syncLinkOpenIntentFromKeyboard,
            onWindowBlur: clearLinkOpenIntent,
            onDocumentStateChanged: handleDocumentStateChanged,
        },
        documentStateChangedEvent,
    );
    configureCaret({
        onBlockFocused: (block) => {
            syncActiveBlockIndicator(block);
            syncBlockSourceReveal(block);
            syncDocumentOutlineToBlock(block);
        },
    });
    configurePointerInteractions({
        onBlockActivated: syncActiveBlockIndicator,
    });
    configureMarkdownSourceController({
        markEditorDirty,
        syncBlockMarkdownSourceReveal: syncBlockSourceReveal,
    });
    configureMarkdownTokenController({
        syncActiveBlockIndicator,
        syncActiveBlockMarkdownSource,
        syncBlockMarkdownSourceReveal: syncBlockSourceReveal,
    });
    configureEditorUiState({
        hasBlockSource: (type) => Boolean(getActiveDocumentFormat().hasBlockSource?.(type)),
    });
    configureBlockOperations({
        parseFragment: (content) => getActiveDocumentFormat().parseFragment(content),
    });
    bindDocumentActions({ loadDocument, serializeDocument });
    void restoreLastOpenDirectory();
    void restoreLastOpenDocument();
    startDocumentAutosave();

    syncDocumentFormatUi();
    syncBlockViewContext();
    syncFirstBlockPlaceholder();
    syncDocumentWindowTitle();
}

function handleEditorSelectionChange(): void {
    handleSelectionChange();
    syncSelectedBlockSourceReveal();
    syncDocumentOutlineToSelection();
}

function syncSelectedBlockSourceReveal(): void {
    const selectedRange = getSelectedBlockRange();
    if (selectedRange) {
        syncBlockSourceRevealBlocks(selectedRange.blocks);
    }
}

function handleDocumentStateChanged(): void {
    syncDocumentFormatUi();
    syncBlockViewContext();
    syncDocumentWindowTitle();
}

function handleGlobalKeydown(event: KeyboardEvent): void {
    handleGlobalKeydownCommand(event, {
        newDocument: () => createNewMarkdownDocument(getSuggestedFileName()),
        openDirectory: () => openDirectoryFromShortcut?.(),
        saveDocument: saveDocumentFromEditor,
        toggleFileTree: () => toggleFileTreeFromShortcut?.(),
    });
}

async function saveDocumentFromEditor(promptForPath = false): Promise<void> {
    await saveCurrentDocument({
        promptForPath: promptForPath || !documentState.activeFilePath,
        suggestedFileName: getSuggestedFileName(),
    });
}

function handleTitleInput(): void {
    if (!getActiveDocumentFormat().supportsTitle) {
        return;
    }

    beginTypingUndoTransaction();
    commitUndoTransaction();
    syncDocumentWindowTitle();
    markDocumentDirty();
}

function handleTitleFocus(): void {
    flushPendingUndoTransaction();
    syncActiveBlockIndicator(null);
    syncBlockSourceReveal(null);
}

function handleTitleBlur(): void {
    flushPendingUndoTransaction();
    if (documentState.activeFilePath && documentState.hasUnsavedChanges) {
        void saveCurrentDocument();
    }
}

function handleEditorMouseDown(event: MouseEvent): void {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.classList.contains("todo-checkbox")) {
        beginDiscreteUndoTransaction();
    } else {
        flushPendingUndoTransaction();
    }

    handleEditorMouseDownCommand(event);
}

function handleEditorChange(event: Event): void {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.classList.contains("todo-checkbox")) {
        const block = findBlock(target);
        if (block) {
            setBlockText(block, getBlockText(block));
        }

        syncActiveBlockIndicator(block);
        syncBlockSourceReveal(block);
        commitUndoTransaction();
        markDocumentDirty();
    }
}

function handleEditorKeydown(event: KeyboardEvent): void {
    if (isUndoShortcut(event)) {
        event.preventDefault();
        if (undoEditorChange()) {
            markEditorDirty();
        }
        return;
    }

    if (isRedoShortcut(event)) {
        event.preventDefault();
        if (redoEditorChange()) {
            markEditorDirty();
        }
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

    handleEditorKeydownCommand(event, {
        isComposingText,
        markEditorDirty,
    });

    if (shouldTrackDiscreteEdit || shouldTrackPlainTextSelectionReplacement) {
        commitUndoTransaction();
    }
}

function handleEditorBeforeInput(event: InputEvent): void {
    const undoKind = readBeforeInputUndoKind(event);
    if (undoKind === "typing") {
        beginTypingUndoTransaction();
        shouldFlushTypingBatchAfterInput = shouldEndTypingBatchAfterInput(event);
    } else if (undoKind === "discrete") {
        beginDiscreteUndoTransaction();
        shouldFlushTypingBatchAfterInput = false;
    }

    handleEditorBeforeInputCommand(event, {
        isComposingText,
        markDocumentDirty,
        markEditorDirty,
        syncBlockSourceReveal,
    });

    if (event.defaultPrevented && undoKind) {
        commitUndoTransaction();
        flushTypingBatchAfterInputIfNeeded();
    }
}

function handleEditorCompositionStart(): void {
    isComposingText = true;
}

function handleEditorCompositionEnd(event: CompositionEvent): void {
    isComposingText = false;
    handleEditorInput(event);
}

function handleEditorInput(event: Event): void {
    handleEditorInputCommand(event, {
        isComposingText,
        markDocumentDirty,
        markEditorDirty,
        syncBlockSourceReveal,
    });
    commitUndoTransaction();
    flushTypingBatchAfterInputIfNeeded();
}

function handleEditorPaste(event: ClipboardEvent): void {
    beginDiscreteUndoTransaction();
    void handleEditorPasteCommand(event, {
        getActiveDocumentFormat,
        getActiveFilePath: () => documentState.activeFilePath,
        ensureDocumentSaved: () =>
            saveCurrentDocument({
                promptForPath: true,
                suggestedFileName: getSuggestedFileName(),
            }),
        markEditorDirty,
    }).finally(commitUndoTransaction);
}

function handleEditorCopy(event: ClipboardEvent): void {
    handleEditorCopyCommand(event, {
        getActiveDocumentFormat,
        markEditorDirty,
    });
}

function handleEditorCut(event: ClipboardEvent): void {
    beginDiscreteUndoTransaction();
    handleEditorCutCommand(event, {
        getActiveDocumentFormat,
        markEditorDirty,
    });
    commitUndoTransaction();
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

function isTodoCheckboxActivation(event: KeyboardEvent): boolean {
    return (
        event.target instanceof HTMLInputElement &&
        event.target.classList.contains("todo-checkbox") &&
        (event.key === " " || event.key === "Enter")
    );
}

function isTypingBoundaryKeydown(event: KeyboardEvent): boolean {
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

function readBeforeInputUndoKind(event: InputEvent): "typing" | "discrete" | null {
    if (isComposingText) {
        return null;
    }

    if (event.inputType === "insertText" || event.inputType === "insertCompositionText") {
        return "typing";
    }

    if (
        event.inputType === "deleteContentBackward" ||
        event.inputType === "deleteContentForward" ||
        event.inputType === "deleteByCut"
    ) {
        return "typing";
    }

    if (event.inputType.startsWith("format") || event.inputType.startsWith("insert")) {
        return "discrete";
    }

    return null;
}

function shouldEndTypingBatchAfterInput(event: InputEvent): boolean {
    if (event.inputType !== "insertText" || event.data === null) {
        return false;
    }

    return /[\s.,;:!?()[\]{}"'`]/.test(event.data);
}

function flushTypingBatchAfterInputIfNeeded(): void {
    if (!shouldFlushTypingBatchAfterInput) {
        return;
    }

    shouldFlushTypingBatchAfterInput = false;
    flushPendingUndoTransaction();
}
