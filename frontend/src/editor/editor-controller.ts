import { installWritingInterface } from "./writing-interface";
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
    toggleMarkdownEditingMode,
} from "../documents/document-session";
import { extensionFromPath, titleFromFileName } from "../formats/file-names";
import { syncDocumentPreview } from "../documents/document-preview";
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
    const findReplaceController = installFindReplaceController({
        editor: dom.editor,
        shell: dom.shell,
    });
    const openFind = (): void => {
        writingInterface.close();
        findReplaceController.openFind();
    };
    const openReplace = (): void => {
        writingInterface.close();
        findReplaceController.openReplace();
    };
    const toggleFileTree = (): void => {
        findReplaceController.close();
        writingInterface.toggleFiles();
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
        surface: dom.surface,
        openFind,
        openReplace,
        createNewDocument: () => createNewMarkdownDocument(getSuggestedFileName()),
        openDocument,
        openDirectory: () => writingInterface.openDirectory(),
        saveDocument: saveDocumentFromEditor,
        ensureExportSaved,
        toggleFileTree,
        toggleMarkdownEditingMode,
        canExport: () => Boolean(getActiveDocumentFormat().export),
        executeEditorCommand: inputController.executeCommand,
        canExecuteEditorCommand: inputController.canExecuteCommand,
        isEditorCommandActive: inputController.isCommandActive,
    });
    const writingInterface = installWritingInterface({
        openDocumentPath,
        readCommandState: appMenuController.readCommandState,
        executeCommand: appMenuController.executeCommand,
    });

    let previousSession = -1;
    let previousFormat = "";
    let previousMode = "";
    let previousPath: string | null | undefined;
    let previousFileName = "";
    let previousCommittedFileName = "";
    let previousSaving: boolean | undefined;
    let previousDirty: boolean | undefined;

    dom.surface.addEventListener("pointerdown", handleDocumentSurfaceMouseDown);
    dom.surface.addEventListener("pointermove", handleDocumentSurfaceMouseMove);
    dom.surface.addEventListener("pointerleave", clearGutterHoverBlock);
    dom.surface.addEventListener("mouseover", handleDocumentSurfaceMouseOver);
    dom.surface.addEventListener("mouseout", handleDocumentSurfaceMouseOut);
    document.addEventListener("pointermove", handleDocumentMouseMove);
    document.addEventListener("pointerup", handleDocumentMouseUp);
    document.addEventListener("pointercancel", handleDocumentMouseUp);
    dom.editor.addEventListener("keydown", inputController.handleEditorKeydown);
    dom.editor.addEventListener("pointerdown", inputController.handleEditorMouseDown);
    dom.editor.addEventListener("beforeinput", inputController.handleEditorBeforeInput);
    dom.editor.addEventListener("copy", inputController.handleEditorCopy);
    dom.editor.addEventListener("cut", inputController.handleEditorCut);
    dom.editor.addEventListener("paste", inputController.handleEditorPaste);
    dom.editor.addEventListener("dragstart", inputController.handleEditorDragStart);
    dom.editor.addEventListener("dragend", inputController.handleEditorDragEnd);
    dom.editor.addEventListener("dragover", inputController.handleEditorDragOver);
    dom.editor.addEventListener("drop", inputController.handleEditorDrop);
    dom.editor.addEventListener("change", inputController.handleEditorChange);
    dom.editor.addEventListener("click", inputController.handleEditorClick);
    dom.editor.addEventListener("compositionstart", inputController.handleEditorCompositionStart);
    dom.editor.addEventListener("compositionend", inputController.handleEditorCompositionEnd);
    dom.editor.addEventListener("focusout", (event) => {
        if (
            (!(event.relatedTarget instanceof Node) || !dom.editor.contains(event.relatedTarget)) &&
            !inputController.containsExternalInteractionTarget(event.relatedTarget) &&
            !(event.relatedTarget instanceof Element && event.relatedTarget.closest(".writing-panel, .writing-header"))
        ) {
            inputController.deactivate();
        }
    });
    dom.title.addEventListener("beforeinput", titleController.handleTitleBeforeInput);
    dom.title.addEventListener("keydown", titleController.handleTitleKeydown);
    dom.title.addEventListener("input", titleController.handleTitleInput);
    dom.title.addEventListener("focus", titleController.handleTitleFocus);
    dom.title.addEventListener("blur", titleController.handleTitleBlur);
    document.addEventListener("selectionchange", () => {
        selectionController.handleEditorSelectionChange();
        inputController.handleEditorSelectionChange();
    });
    window.addEventListener("keydown", (event) => handleGlobalKeydown(event, appMenuController.executeCommand));
    window.addEventListener("keyup", syncLinkOpenIntentFromKeyboard);
    window.addEventListener("blur", () => {
        clearLinkOpenIntent();
        inputController.deactivate();
    });
    function syncDocumentPresentation(): void {
        const reinitialized = previousSession !== documentState.sessionId ||
            previousFormat !== documentState.activeFormatId || previousMode !== documentState.editingMode;
        const pathChanged = previousPath !== documentState.activeFilePath;
        const dirtyChanged = previousDirty !== documentState.hasUnsavedChanges;
        const formatUiChanged = reinitialized || pathChanged || previousFileName !== documentState.fileName ||
            previousSaving !== documentState.isSavingDocument;
        if (previousSession !== documentState.sessionId || previousCommittedFileName !== documentState.committedFileName) {
            dom.title.value = titleFromFileName(documentState.committedFileName);
        }
        previousCommittedFileName = documentState.committedFileName;
        previousSession = documentState.sessionId;
        previousFormat = documentState.activeFormatId;
        previousMode = documentState.editingMode;
        previousPath = documentState.activeFilePath;
        previousFileName = documentState.fileName;
        previousSaving = documentState.isSavingDocument;
        previousDirty = documentState.hasUnsavedChanges;
        if (reinitialized) {
            selectionController.refresh();
            refreshDocumentOutline();
            findReplaceController.refresh();
        }
        if (formatUiChanged) syncDocumentFormatUi();
        else if (dirtyChanged) syncDocumentPreview(getActiveDocumentFormat(), {
            activeFilePath: documentState.activeFilePath,
            isSavingDocument: documentState.isSavingDocument,
        });
        syncDocumentWindowTitle();
    }
    window.addEventListener(documentStateChangedEvent, syncDocumentPresentation);
    configureCaret({
        onBlockFocused: (block) => {
            syncFocusedBlockUi(block);
        },
    });
    configurePointerInteractions({
        onBlockActivated: syncActiveBlockIndicator,
        getProjectionCapability: () => getActiveDocumentFormat().projection,
    });
    installSourceStateDocumentIntegration(() => {
        refreshDocumentOutline();
        findReplaceController.refresh();
    });
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

    syncDocumentPresentation();
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

let formatUiSignature = "";

function syncDocumentFormatUi(): void {
    const { shell, surface, title, extension, markdownModeToggle } = readEditorDom();
    const format = getActiveDocumentFormat();

    const activeExtension = extensionFromPath(documentState.fileName) || format.descriptor.defaultExtension;
    const signature = JSON.stringify([format.descriptor.id, format.descriptor.editableTitle, activeExtension, documentState.editingMode]);
    if (signature !== formatUiSignature) {
        formatUiSignature = signature;
        title.hidden = false;
        title.readOnly = !format.descriptor.editableTitle;
        title.setAttribute("aria-readonly", String(title.readOnly));
        extension.textContent = `.${activeExtension}`;
        extension.setAttribute("aria-label", `${activeExtension} file extension`);
        surface.dataset.documentFormat = format.descriptor.id;
        shell.dataset.documentFormat = format.descriptor.id;
        surface.dataset.editingMode = documentState.editingMode;
        shell.dataset.editingMode = documentState.editingMode;
        const canToggleMarkdownMode = format.descriptor.id === "markdown";
        markdownModeToggle.hidden = !canToggleMarkdownMode;
        markdownModeToggle.textContent = isMarkdownSourceMode() ? "Source" : "Live Preview";
        markdownModeToggle.setAttribute("aria-pressed", String(isMarkdownSourceMode()));
        markdownModeToggle.title = isMarkdownSourceMode()
            ? "Switch to Markdown Live Preview"
            : "Switch to Markdown source mode";
    }

    syncDocumentPreview(format, {
        activeFilePath: documentState.activeFilePath,
        isSavingDocument: documentState.isSavingDocument,
    });
}
