import { Events } from "@wailsio/runtime";
import {
    chooseDocumentToOpen,
    chooseDocumentToSave,
    chooseUnsavedDocumentDecision,
    readDocument,
    renameDocument,
    saveDocument,
} from "../bridge/documents";
import { onOpenDocumentRequested, takePendingOpenDocumentPaths } from "../bridge/launch";
import type { DocumentFile } from "../bridge/types";
import { getDocumentFormatById, getDocumentFormatForPath } from "../formats/registry";
import {
    finalizePendingImages,
    hasPendingImagesInContent,
    preparePendingImagesForSave,
    type PreparedPendingImages,
} from "../formats/markdown/pending-images";
import { reportEditorError } from "../editor/editor-status";
import { getElement } from "../utils/dom";
import { fileNameFromPath } from "../utils/text";
import { canUseNativeRuntime } from "../platform/runtime";
import { documentState, notifyDocumentStateChanged, recordSavedDocumentContent } from "./document-state";
import { notifyDirectoryTreeChanged } from "./file-tree";
import {
    forgetLastOpenDocumentPath,
    getLastOpenDocumentPath,
    rememberLastOpenDocumentPath,
} from "./document-storage";
import {
    areSamePath,
    normalizeSuggestedFileName,
    resolveEditedActiveFilePath,
} from "./save-paths";

type DocumentActionHost = {
    loadDocument: (documentFile: DocumentFile) => void;
    serializeDocument: () => string;
    commitSavedDocument: (path: string, savedContent: string) => void;
};

type SaveDocumentOptions = {
    promptForPath?: boolean;
    suggestedFileName?: string;
};

const autoSaveIntervalMs = 30_000;
const windowCloseRequestedEvent = "glyph:window-close-requested";
const windowCloseConfirmedEvent = "glyph:window-close-confirmed";

let host: DocumentActionHost | null = null;
let pendingOpenDocumentDrain: Promise<boolean> | null = null;
let pendingWindowCloseConfirmation = false;

export function bindDocumentActions(nextHost: DocumentActionHost): void {
    host = nextHost;
    recordSavedDocumentContent(nextHost.serializeDocument());
    notifyDocumentStateChanged();
}

export function installOpenDocumentRequests(): void {
    onOpenDocumentRequested(() => void openPendingLaunchDocuments());
}

export function installWindowCloseRequests(readSuggestedFileName: () => string): void {
    Events.On(windowCloseRequestedEvent, () => {
        void confirmWindowClose(readSuggestedFileName);
    });
}

export async function openPendingLaunchDocuments(): Promise<boolean> {
    if (pendingOpenDocumentDrain) {
        return pendingOpenDocumentDrain;
    }

    pendingOpenDocumentDrain = drainPendingLaunchDocuments();
    try {
        return await pendingOpenDocumentDrain;
    } finally {
        pendingOpenDocumentDrain = null;
    }
}

export function startDocumentAutosave(): void {
    window.setInterval(() => void saveCurrentDocument(), autoSaveIntervalMs);
}

export async function restoreLastOpenDocument(): Promise<void> {
    if (documentState.isOpeningDocument || !canUseDesktopFileSystem()) {
        return;
    }

    const path = getLastOpenDocumentPath();
    if (!path) {
        return;
    }

    documentState.isOpeningDocument = true;
    notifyDocumentStateChanged();

    try {
        getHost().loadDocument(await readDocument(path));
        rememberLastOpenDocumentPath(path);
    } catch (error) {
        forgetLastOpenDocumentPath();
        console.error("Failed to restore last open file:", error);
    } finally {
        documentState.isOpeningDocument = false;
        notifyDocumentStateChanged();
    }
}

async function drainPendingLaunchDocuments(): Promise<boolean> {
    if (!canUseDesktopFileSystem()) {
        return false;
    }

    if (documentState.isOpeningDocument) {
        window.setTimeout(() => void openPendingLaunchDocuments(), 100);
        return false;
    }

    const paths = await takePendingOpenDocumentPaths();
    const path = paths[paths.length - 1];
    if (!path) {
        return false;
    }

    await openDocumentPath(path);
    return true;
}

export function canUseDesktopFileSystem(): boolean {
    return canUseNativeRuntime();
}

export async function openDocument(): Promise<void> {
    if (documentState.isOpeningDocument || !canUseDesktopFileSystem()) {
        return;
    }

    documentState.isOpeningDocument = true;
    notifyDocumentStateChanged();

    try {
        if (!(await prepareToLeaveDocument())) {
            return;
        }

        const selectedPath = await chooseDocumentToOpen();
        if (!selectedPath) {
            return;
        }

        getHost().loadDocument(await readDocument(selectedPath));
        rememberLastOpenDocumentPath(selectedPath);
    } catch (error) {
        console.error("Failed to open file:", error);
        reportEditorError(error instanceof Error ? error.message : "Could not open the document.");
    } finally {
        documentState.isOpeningDocument = false;
        notifyDocumentStateChanged();
    }
}

export async function openDocumentPath(path: string): Promise<void> {
    if (documentState.isOpeningDocument || !canUseDesktopFileSystem()) {
        return;
    }

    documentState.isOpeningDocument = true;
    notifyDocumentStateChanged();

    try {
        if (!(await prepareToLeaveDocument())) {
            return;
        }

        getHost().loadDocument(await readDocument(path));
        rememberLastOpenDocumentPath(path);
    } catch (error) {
        console.error("Failed to open file:", error);
        reportEditorError(error instanceof Error ? error.message : "Could not open the document.");
    } finally {
        documentState.isOpeningDocument = false;
        notifyDocumentStateChanged();
    }
}

export async function createNewMarkdownDocument(suggestedFileName?: string): Promise<void> {
    if (documentState.isOpeningDocument) {
        return;
    }

    documentState.isOpeningDocument = true;
    notifyDocumentStateChanged();

    try {
        if (!(await prepareToLeaveDocument({ suggestedFileName }))) {
            return;
        }

        getHost().loadDocument({
            path: "",
            name: "Untitled.md",
            content: "",
        });
    } catch (error) {
        console.error("Failed to create new markdown file:", error);
        reportEditorError("Could not create a new document session.");
    } finally {
        documentState.isOpeningDocument = false;
        notifyDocumentStateChanged();
    }
}

export async function saveCurrentDocument(options: SaveDocumentOptions = {}): Promise<boolean> {
    if (!canUseDesktopFileSystem()) {
        return false;
    }

    if (!documentState.activeFilePath && !options.promptForPath) {
        return true;
    }

    if (documentState.activeFilePath && !documentState.hasUnsavedChanges && !options.promptForPath) {
        return true;
    }

    if (documentState.isSavingDocument) {
        documentState.saveAgainAfterCurrent = true;
        notifyDocumentStateChanged();
        return false;
    }

    const saveSessionId = documentState.sessionId;
    const previousPath = documentState.activeFilePath;
    documentState.isSavingDocument = true;
    notifyDocumentStateChanged();
    let saved = false;
    let writeStarted = false;

    try {
        const path = await resolveSavePath(options);
        if (!path || documentState.sessionId !== saveSessionId) {
            return false;
        }

        const targetFormat = getDocumentFormatForPath(path);
        let content = getHost().serializeDocument();
        const pathChanged = Boolean(previousPath && !areSamePath(previousPath, path));
        let preparedImages: PreparedPendingImages = { content, replacements: [] };

        if (hasPendingImagesInContent(content)) {
            if (targetFormat.descriptor.id !== "markdown") {
                reportEditorError("Save as Markdown or remove pending images.");
                return false;
            }
            preparedImages = await preparePendingImagesForSave(path, content, saveSessionId);
            content = preparedImages.content;
        }

        if (documentState.sessionId !== saveSessionId) {
            return false;
        }
        if (content === documentState.lastSavedContent && !pathChanged && !options.promptForPath) {
            documentState.hasUnsavedChanges = false;
            return true;
        }

        writeStarted = true;
        if (pathChanged && previousPath && !options.promptForPath) {
            await renameDocument(previousPath, path);
        }

        await saveDocument(path, content);
        if (documentState.sessionId !== saveSessionId) {
            return false;
        }
        finalizePendingImages(preparedImages, saveSessionId);
        getHost().commitSavedDocument(path, content);
        documentState.hasUnsavedChanges = getHost().serializeDocument() !== content || documentState.fileNameDirty;
        rememberLastOpenDocumentPath(path);
        if (!previousPath || pathChanged) {
            notifyDirectoryTreeChanged();
        }

        saved = !documentState.hasUnsavedChanges;
        window.dispatchEvent(new Event("glyph:document-saved"));
    } catch (error) {
        documentState.hasUnsavedChanges = true;
        console.error("Failed to save file:", error);
        reportEditorError(error instanceof Error ? error.message : "Could not save the document.");
    } finally {
        documentState.isSavingDocument = false;
        notifyDocumentStateChanged();

        if (documentState.saveAgainAfterCurrent && writeStarted) {
            documentState.saveAgainAfterCurrent = false;
            void saveCurrentDocument();
        } else {
            documentState.saveAgainAfterCurrent = false;
        }
    }

    return saved;
}

async function confirmUnsavedDocumentAction(options: SaveDocumentOptions = {}): Promise<boolean> {
    if (!documentState.hasUnsavedChanges) {
        return true;
    }

    const decision = await chooseUnsavedDocumentDecision();
    if (decision === "discard") {
        return true;
    }

    if (decision === "cancel") {
        return false;
    }

    return saveCurrentDocument({
        ...options,
        promptForPath: !documentState.activeFilePath,
    });
}

async function prepareToLeaveDocument(options: SaveDocumentOptions = {}): Promise<boolean> {
    if (!documentState.hasUnsavedChanges) {
        return true;
    }

    if (documentState.activeFilePath) {
        return saveCurrentDocument();
    }

    return confirmUnsavedDocumentAction(options);
}

async function confirmWindowClose(readSuggestedFileName: () => string): Promise<void> {
    if (pendingWindowCloseConfirmation) {
        return;
    }

    pendingWindowCloseConfirmation = true;
    try {
        const shouldClose = await prepareToLeaveDocument({
            suggestedFileName: readSuggestedFileName(),
        });
        if (!shouldClose) {
            return;
        }

        await Events.Emit(windowCloseConfirmedEvent, null);
    } finally {
        pendingWindowCloseConfirmation = false;
    }
}

async function resolveSavePath(options: SaveDocumentOptions): Promise<string | null> {
    if (!options.promptForPath && documentState.activeFilePath) {
        return resolveEditedActiveFilePath(
            documentState.activeFilePath,
            getElement<HTMLInputElement>("document-title").value,
            getDocumentFormatById(documentState.activeFormatId).descriptor.defaultExtension,
        );
    }

    const defaultExtension = getDocumentFormatById(documentState.activeFormatId).descriptor.defaultExtension;
    const defaultFileName = getDocumentFormatById(documentState.activeFormatId).descriptor.defaultFileName;
    const titleFileName = getElement<HTMLInputElement>("document-title").value.trim();
    const suggestedFileName =
        (options.suggestedFileName ??
            (documentState.fileNameDirty ? documentState.fileName : null) ??
            (documentState.activeFilePath ? fileNameFromPath(documentState.activeFilePath) : null) ??
            titleFileName) ||
        defaultFileName;

    const selectedPath = await chooseDocumentToSave(
        normalizeSuggestedFileName(suggestedFileName, defaultExtension),
    );

    if (!selectedPath) {
        return null;
    }

    return selectedPath;
}

function getHost(): DocumentActionHost {
    if (!host) {
        throw new Error("Document actions have not been bound");
    }

    return host;
}
