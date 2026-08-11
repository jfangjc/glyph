import { handleGlobalKeydown as handleGlobalKeydownCommand } from "../app/global-shortcuts";
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
    commitSavedDocument,
    installSourceStateDocumentIntegration,
    loadDocument,
    serializeDocument,
    syncBlockViewContext,
    syncDocumentFormatUi,
} from "../documents/document-session";
import { installFileTree, restoreLastOpenDirectory } from "../documents/file-tree";
import type { DocumentEditorHooks } from "./core/types";
import {
    appMenuCommandEvent,
} from "../platform/window-controls/window-controls";
import {
    createAppMenuController,
} from "./controllers/app-menu-controller";
import {
    createEditorInputController,
} from "./controllers/editor-input-controller";
import {
    createSelectionController,
} from "./controllers/selection-controller";
import {
    createTitleController,
} from "./controllers/title-controller";
import {
    installDocumentOutline,
    syncDocumentOutlineToBlock,
} from "./document-outline";
import { readEditorDom } from "./editor-dom";
import { installEditorEventListeners } from "./editor-events";
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
    syncLinkOpenIntentFromKeyboard,
} from "./pointer-interactions";
import { configureCaret } from "./selection/caret";
import {
    installFindReplaceController,
} from "./find-replace";
import { installNativeSourceNavigationTracker } from "./core/projection";

export function installEditorController(): void {
    const dom = readEditorDom();
    const editorHooks = createDocumentEditorHooks();

    installDocumentOutline(dom.shell, dom.editor);
    const fileTree = installFileTree(dom.shell, {
        openDocumentPath,
    });
    const findReplaceController = installFindReplaceController({
        editor: dom.editor,
        shell: dom.shell,
    });
    const inputController = createEditorInputController({
        hooks: editorHooks,
        getActiveDocumentFormat,
        getActiveFilePath: () => documentState.activeFilePath,
    });
    const titleController = createTitleController({
        getActiveDocumentFormat,
        isComposingText: inputController.isComposingText,
        hasActiveFileWithUnsavedChanges: () =>
            Boolean(documentState.activeFilePath && documentState.hasUnsavedChanges),
        saveDocument: () => saveCurrentDocument({ promptForPath: !documentState.activeFilePath }),
        syncActiveBlockIndicator,
        syncBlockSourceReveal,
    });
    const selectionController = createSelectionController({
        hooks: editorHooks,
        isComposingText: inputController.isComposingText,
    });
    const appMenuController = createAppMenuController({
        editor: dom.editor,
        surface: dom.surface,
        findReplaceController,
        createNewDocument: () => createNewMarkdownDocument(getSuggestedFileName()),
        openDocument,
        openDirectory: fileTree.openDirectory,
        saveDocument: saveDocumentFromEditor,
        ensureExportSaved,
        toggleFileTree: fileTree.toggle,
        canExport: () => Boolean(getActiveDocumentFormat().export),
        executeEditorCommand: inputController.executeCommand,
    });

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
            onEditorInput: inputController.handleEditorInput,
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
                if (!(event.relatedTarget instanceof Node) || !dom.editor.contains(event.relatedTarget)) {
                    inputController.deactivate();
                }
            },
            onTitleBeforeInput: titleController.handleTitleBeforeInput,
            onTitleKeydown: titleController.handleTitleKeydown,
            onTitleInput: titleController.handleTitleInput,
            onTitleFocus: titleController.handleTitleFocus,
            onTitleBlur: titleController.handleTitleBlur,
            onSelectionChange: selectionController.handleEditorSelectionChange,
            onWindowKeydown: (event) =>
                handleGlobalKeydown(event, {
                    openFind: () => findReplaceController.openFind(),
                    openReplace: () => findReplaceController.openReplace(),
                    newDocument: () => createNewMarkdownDocument(getSuggestedFileName()),
                    openDocument,
                    openDirectory: fileTree.openDirectory,
                    saveDocument: saveDocumentFromEditor,
                    toggleFileTree: fileTree.toggle,
                }),
            onWindowKeyup: syncLinkOpenIntentFromKeyboard,
            onWindowBlur: () => {
                clearLinkOpenIntent();
                inputController.deactivate();
            },
            onDocumentStateChanged: () => {
                selectionController.resetSelectionSignature();
                syncDocumentFormatUi();
                syncBlockViewContext();
                syncDocumentWindowTitle();
                appMenuController.syncExportMenuState();
                findReplaceController.refresh();
            },
        },
        documentStateChangedEvent,
    );
    window.addEventListener(appMenuCommandEvent, appMenuController.handleAppMenuCommand as EventListener);
    configureCaret({
        onBlockFocused: (block) => {
            syncActiveBlockIndicator(block);
            syncBlockSourceReveal(block);
            syncDocumentOutlineToBlock(block);
        },
    });
    configurePointerInteractions({
        onBlockActivated: syncActiveBlockIndicator,
        getProjectionCapability: () => getActiveDocumentFormat().projection,
    });
    installNativeSourceNavigationTracker(dom.editor);
    configureEditorUiState({
        hasBlockSource: (type) => Boolean(getActiveDocumentFormat().render.hasBlockSource?.(type)),
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
    void restoreLastOpenDirectory();
    void restoreStartupDocument();
    startDocumentAutosave();

    syncDocumentFormatUi();
    syncBlockViewContext();
    syncDocumentWindowTitle();
    appMenuController.syncExportMenuState();
}

async function restoreStartupDocument(): Promise<void> {
    if (!(await openPendingLaunchDocuments())) {
        await restoreLastOpenDocument();
    }
}

function createDocumentEditorHooks(): DocumentEditorHooks {
    return {
        syncActiveBlockIndicator,
        syncBlockSourceReveal,
        syncBlockSourceRevealBlocks,
    };
}

function handleGlobalKeydown(
    event: KeyboardEvent,
    options: Parameters<typeof handleGlobalKeydownCommand>[1],
): void {
    handleGlobalKeydownCommand(event, options);
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
