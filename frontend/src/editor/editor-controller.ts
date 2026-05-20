import { getSuggestedFileName, syncDocumentWindowTitle } from "../app/window-title";
import { handleGlobalKeydown as handleGlobalKeydownCommand } from "../app/global-shortcuts";
import {
    bindDocumentActions,
    saveCurrentDocument,
    startDocumentAutosave,
} from "../documents/document-actions";
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
import { configureBlockOperations } from "./block-operations";
import {
    findBlock,
    getBlockText,
    setBlockText,
    syncFirstBlockPlaceholder,
} from "./block-view";
import { configureCaret } from "./caret";
import { getElement } from "./dom-utils";
import {
    handleEditorCopy as handleEditorCopyCommand,
    handleEditorCut as handleEditorCutCommand,
    handleEditorPaste as handleEditorPasteCommand,
} from "./editor-clipboard";
import {
    handleEditorBeforeInput as handleEditorBeforeInputCommand,
    handleEditorInput as handleEditorInputCommand,
} from "./editor-input";
import { installEditorEventListeners } from "./editor-events";
import { handleEditorKeydown as handleEditorKeydownCommand } from "./editor-keydown";
import {
    configureEditorUiState,
    syncActiveBlockIndicator,
    syncBlockSourceReveal,
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
    handleEditorMouseDown,
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

export function installEditorController(): void {
    const surface = getElement<HTMLElement>("document-surface");
    const editor = getElement<HTMLElement>("editor");
    const title = getElement<HTMLInputElement>("document-title");

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
            onSelectionChange: handleSelectionChange,
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
    startDocumentAutosave();

    syncDocumentFormatUi();
    syncBlockViewContext();
    syncFirstBlockPlaceholder();
    syncDocumentWindowTitle();
}

function handleDocumentStateChanged(): void {
    syncDocumentFormatUi();
    syncBlockViewContext();
    syncDocumentWindowTitle();
}

function handleGlobalKeydown(event: KeyboardEvent): void {
    handleGlobalKeydownCommand(event, {
        saveDocument: saveDocumentFromEditor,
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

    documentState.usesTitle = true;
    markDocumentDirty();
}

function handleTitleFocus(): void {
    syncActiveBlockIndicator(null);
    syncBlockSourceReveal(null);
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
        markDocumentDirty();
    }
}

function handleEditorKeydown(event: KeyboardEvent): void {
    handleEditorKeydownCommand(event, {
        isComposingText,
        markEditorDirty,
    });
}

function handleEditorBeforeInput(event: InputEvent): void {
    handleEditorBeforeInputCommand(event, {
        isComposingText,
        markDocumentDirty,
        markEditorDirty,
        syncBlockSourceReveal,
    });
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
}

function handleEditorPaste(event: ClipboardEvent): void {
    handleEditorPasteCommand(event, {
        getActiveDocumentFormat,
        markEditorDirty,
    });
}

function handleEditorCopy(event: ClipboardEvent): void {
    handleEditorCopyCommand(event, {
        getActiveDocumentFormat,
        markEditorDirty,
    });
}

function handleEditorCut(event: ClipboardEvent): void {
    handleEditorCutCommand(event, {
        getActiveDocumentFormat,
        markEditorDirty,
    });
}
