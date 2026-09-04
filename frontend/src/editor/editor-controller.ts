import { handleGlobalKeydown } from "../app/global-shortcuts";
import { getSuggestedFileName, syncDocumentWindowTitle } from "../app/window-title";
import {
    bindDocumentActions,
    canUseDesktopFileSystem,
    createNewMarkdownDocument,
    installOpenDocumentRequests,
    installWindowCloseRequests,
    openDocument,
    openDocumentPath,
    openPendingLaunchDocuments,
    restoreLastOpenDocument,
    saveCurrentDocument,
    startDocumentAutosave,
} from "../documents/document-actions";
import {
    documentState,
    documentStateChangedEvent,
} from "../documents/document-state";
import {
    getActiveDocumentFormat,
    isMarkdownSourceMode,
    commitSavedDocument,
    installSourceStateDocumentIntegration,
    loadDocument,
    serializeDocument,
    syncBlockViewContext,
    syncDocumentFormatUi,
    toggleMarkdownEditingMode,
} from "../documents/document-session";
import { installFileTree } from "../documents/file-tree";
import {
    appMenuCommandEvent,
} from "../platform/window-controls/window-controls";
import {
    createAppMenuController,
} from "./controllers/app-menu-controller";
import { createEditorInputController } from "./controllers/editor-input-controller";
import {
    createSelectionController,
} from "./controllers/selection-controller";
import {
    createTitleController,
} from "./controllers/title-controller";
import {
    installDocumentOutline,
    refreshDocumentOutline,
    syncDocumentOutlineToBlock,
} from "./document-outline";
import { readEditorDom } from "./editor-dom";
import { installEditorEventListeners } from "./editor-events";
import {
    syncActiveBlockIndicator,
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
    syncLinkOpenIntentFromKeyboard,
} from "./pointer-interactions";
import { configureCaret } from "./selection/caret";
import {
    installFindReplaceController,
} from "./find-replace";

export function installEditorController(): void {
    const dom = readEditorDom();

    installDocumentOutline(dom.shell);
    const fileTree = installFileTree(dom.shell, {
        openDocumentPath,
    });
    const findReplaceController = installFindReplaceController({
        editor: dom.editor,
        shell: dom.shell,
    });
    const openFind = (): void => {
        fileTree.close();
        findReplaceController.openFind();
    };
    const openReplace = (): void => {
        fileTree.close();
        findReplaceController.openReplace();
    };
    const toggleFileTree = (): void => {
        findReplaceController.close();
        fileTree.toggle();
    };
    const inputController = createEditorInputController({
        syncActiveBlockIndicator: syncFocusedBlockUi,
        getActiveDocumentFormat,
        getActiveFilePath: () => documentState.activeFilePath,
        isSourceMode: isMarkdownSourceMode,
    });
    dom.markdownModeToggle.addEventListener("click", toggleMarkdownEditingMode);
    const titleController = createTitleController({
        getActiveDocumentFormat,
        isComposingText: inputController.isComposingText,
        hasActiveFileWithUnsavedChanges: () =>
            Boolean(documentState.activeFilePath && documentState.hasUnsavedChanges),
        saveDocument: () => saveCurrentDocument({ promptForPath: !documentState.activeFilePath }),
        syncActiveBlockIndicator,
    });
    const selectionController = createSelectionController({
        syncActiveBlockIndicator: syncFocusedBlockUi,
        isComposingText: inputController.isComposingText,
    });
    const appMenuController = createAppMenuController({
        editor: dom.editor,
        surface: dom.surface,
        openFind,
        openReplace,
        createNewDocument: () => createNewMarkdownDocument(getSuggestedFileName()),
        openDocument,
        openDirectory: fileTree.openDirectory,
        saveDocument: saveDocumentFromEditor,
        ensureExportSaved,
        toggleFileTree,
        toggleMarkdownEditingMode,
        canToggleMarkdownEditingMode: () => getActiveDocumentFormat().descriptor.id === "markdown",
        isMarkdownSourceMode,
        canExport: () => Boolean(getActiveDocumentFormat().export),
        executeEditorCommand: inputController.executeCommand,
        canExecuteEditorCommand: inputController.canExecuteCommand,
        isEditorCommandActive: inputController.isCommandActive,
    });
    document.addEventListener("selectionchange", () => appMenuController.syncMenuState());

    installEditorEventListeners(
        { surface: dom.surface, editor: dom.editor, title: dom.title },
        {
            onSurfaceMouseDown: handleDocumentSurfaceMouseDown,
            onSurfaceMouseMove: handleDocumentSurfaceMouseMove,
            onSurfaceMouseLeave: clearGutterHoverBlock,
            onSurfaceMouseOver: handleDocumentSurfaceMouseOver,
            onSurfaceMouseOut: handleDocumentSurfaceMouseOut,
            onDocumentMouseMove: handleDocumentMouseMove,
            onDocumentMouseUp: handleDocumentMouseUp,
            onEditorKeydown: inputController.handleEditorKeydown,
            onEditorMouseDown: inputController.handleEditorMouseDown,
            onEditorBeforeInput: inputController.handleEditorBeforeInput,
            onEditorCopy: inputController.handleEditorCopy,
            onEditorCut: inputController.handleEditorCut,
            onEditorPaste: inputController.handleEditorPaste,
            onEditorDragStart: inputController.handleEditorDragStart,
            onEditorDragEnd: inputController.handleEditorDragEnd,
            onEditorDragOver: inputController.handleEditorDragOver,
            onEditorDrop: inputController.handleEditorDrop,
            onEditorChange: inputController.handleEditorChange,
            onEditorClick: inputController.handleEditorClick,
            onEditorCompositionStart: inputController.handleEditorCompositionStart,
            onEditorCompositionEnd: inputController.handleEditorCompositionEnd,
            onEditorFocusOut: (event) => {
                if (
                    (!(event.relatedTarget instanceof Node) || !dom.editor.contains(event.relatedTarget)) &&
                    !inputController.containsExternalInteractionTarget(event.relatedTarget)
                ) {
                    inputController.deactivate();
                }
            },
            onTitleBeforeInput: titleController.handleTitleBeforeInput,
            onTitleKeydown: titleController.handleTitleKeydown,
            onTitleInput: titleController.handleTitleInput,
            onTitleFocus: titleController.handleTitleFocus,
            onTitleBlur: titleController.handleTitleBlur,
            onSelectionChange: () => {
                selectionController.handleEditorSelectionChange();
                inputController.handleEditorSelectionChange();
            },
            onWindowKeydown: (event) =>
                handleGlobalKeydown(event, {
                    openFind,
                    openReplace,
                    newDocument: () => createNewMarkdownDocument(getSuggestedFileName()),
                    openDocument,
                    openDirectory: fileTree.openDirectory,
                    saveDocument: saveDocumentFromEditor,
                    toggleFileTree,
                    toggleMarkdownEditingMode,
                }),
            onWindowKeyup: syncLinkOpenIntentFromKeyboard,
            onWindowBlur: () => {
                clearLinkOpenIntent();
                inputController.deactivate();
            },
            onDocumentStateChanged: () => {
                selectionController.refresh();
                refreshDocumentOutline();
                syncDocumentFormatUi();
                syncBlockViewContext();
                syncDocumentWindowTitle();
                appMenuController.syncMenuState();
                findReplaceController.refresh();
            },
        },
        documentStateChangedEvent,
    );
    window.addEventListener(appMenuCommandEvent, appMenuController.handleAppMenuCommand as EventListener);
    configureCaret({
        onBlockFocused: (block) => {
            syncFocusedBlockUi(block);
        },
    });
    configurePointerInteractions({
        onBlockActivated: syncActiveBlockIndicator,
        getProjectionCapability: () => getActiveDocumentFormat().projection,
    });
    installSourceStateDocumentIntegration();
    if (documentState.sessionId === 0) {
        loadDocument({
            path: "",
            name: "Untitled.md",
            content: "",
        });
    }
    bindDocumentActions({ loadDocument, serializeDocument, commitSavedDocument });
    installOpenDocumentRequests();
    installWindowCloseRequests(getSuggestedFileName);
    void restoreStartupDocument();
    startDocumentAutosave();

    syncDocumentFormatUi();
    syncBlockViewContext();
    syncDocumentWindowTitle();
    appMenuController.syncMenuState();
}

async function restoreStartupDocument(): Promise<void> {
    if (!(await openPendingLaunchDocuments())) {
        await restoreLastOpenDocument();
    }
}

function syncFocusedBlockUi(block: HTMLElement | null): void {
    syncActiveBlockIndicator(block);
    syncDocumentOutlineToBlock(block);
}

async function saveDocumentFromEditor(promptForPath = false): Promise<void> {
    await saveCurrentDocument({
        promptForPath: promptForPath || !documentState.activeFilePath,
        suggestedFileName: getSuggestedFileName(),
    });
}

async function ensureExportSaved(): Promise<boolean> {
    if (!canUseDesktopFileSystem()) {
        return true;
    }

    return saveCurrentDocument({
        promptForPath: !documentState.activeFilePath,
        suggestedFileName: getSuggestedFileName(),
    });
}
