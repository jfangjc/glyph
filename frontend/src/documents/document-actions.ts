import {
    chooseDocumentToOpen,
    chooseDocumentToSave,
    createUntitledMarkdownDocument,
    readDocument,
    renameDocument,
    saveDocument,
} from "../bridge/documents";
import { onOpenDocumentRequested, takePendingOpenDocumentPaths } from "../bridge/launch";
import type { DocumentFile } from "../bridge/types";
import { getDocumentFormatById } from "../formats/registry";
import { getElement } from "../utils/dom";
import { fileNameFromPath } from "../utils/text";
import { canUseNativeRuntime } from "../platform/runtime";
import { documentState, notifyDocumentStateChanged } from "./document-state";
import {
    forgetLastOpenDocumentPath,
    getLastOpenDocumentPath,
    rememberLastOpenDocumentPath,
} from "./document-storage";
import { refreshOpenDirectoryTree } from "./file-tree";
import {
    areSamePath,
    normalizeSuggestedFileName,
    resolveEditedActiveFilePath,
} from "./save-paths";

type DocumentActionHost = {
    loadDocument: (documentFile: DocumentFile) => void;
    serializeDocument: () => string;
};

type SaveDocumentOptions = {
    promptForPath?: boolean;
    suggestedFileName?: string;
};

const autoSaveIntervalMs = 30_000;

let host: DocumentActionHost | null = null;
let pendingOpenDocumentDrain: Promise<boolean> | null = null;

export function bindDocumentActions(nextHost: DocumentActionHost): void {
    host = nextHost;
    documentState.lastSavedContent = nextHost.serializeDocument();
    notifyDocumentStateChanged();
}

export function installOpenDocumentRequests(): void {
    onOpenDocumentRequested(() => void openPendingLaunchDocuments());
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
        if (
            documentState.hasUnsavedChanges &&
            !(await saveCurrentDocument({
                promptForPath: !documentState.activeFilePath,
            }))
        ) {
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
        if (
            documentState.hasUnsavedChanges &&
            !(await saveCurrentDocument({
                promptForPath: !documentState.activeFilePath,
            }))
        ) {
            return;
        }

        getHost().loadDocument(await readDocument(path));
        rememberLastOpenDocumentPath(path);
    } catch (error) {
        console.error("Failed to open file:", error);
    } finally {
        documentState.isOpeningDocument = false;
        notifyDocumentStateChanged();
    }
}

export async function createNewMarkdownDocument(suggestedFileName?: string): Promise<void> {
    if (documentState.isOpeningDocument || !canUseDesktopFileSystem()) {
        return;
    }

    documentState.isOpeningDocument = true;
    notifyDocumentStateChanged();

    try {
        if (
            (!documentState.activeFilePath || documentState.hasUnsavedChanges) &&
            !(await saveCurrentDocument({
                promptForPath: !documentState.activeFilePath,
                suggestedFileName,
            }))
        ) {
            return;
        }

        if (!documentState.activeFilePath) {
            return;
        }

        const documentFile = await createUntitledMarkdownDocument(documentState.activeFilePath);
        getHost().loadDocument(documentFile);
        rememberLastOpenDocumentPath(documentFile.path);
        await refreshOpenDirectoryTree();
    } catch (error) {
        console.error("Failed to create new markdown file:", error);
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

    const previousPath = documentState.activeFilePath;
    const path = await resolveSavePath(options);
    if (!path) {
        return false;
    }

    const content = getHost().serializeDocument();
    const pathChanged = Boolean(previousPath && !areSamePath(previousPath, path));

    if (content === documentState.lastSavedContent && !pathChanged && !options.promptForPath) {
        documentState.hasUnsavedChanges = false;
        notifyDocumentStateChanged();
        return true;
    }

    documentState.isSavingDocument = true;
    notifyDocumentStateChanged();
    let saved = false;

    try {
        if (pathChanged && previousPath && !options.promptForPath) {
            await renameDocument(previousPath, path);
            documentState.activeFilePath = path;
        }

        await saveDocument(path, content);
        if (pathChanged) {
            await refreshOpenDirectoryTree();
        }

        if (documentState.activeFilePath === previousPath || documentState.activeFilePath === path || options.promptForPath) {
            documentState.activeFilePath = path;
            documentState.lastSavedContent = content;
            documentState.hasUnsavedChanges = getHost().serializeDocument() !== documentState.lastSavedContent;
            rememberLastOpenDocumentPath(path);
        }

        saved = !documentState.hasUnsavedChanges;
    } catch (error) {
        documentState.hasUnsavedChanges = true;
        console.error("Failed to save file:", error);
    } finally {
        documentState.isSavingDocument = false;
        notifyDocumentStateChanged();

        if (documentState.saveAgainAfterCurrent) {
            documentState.saveAgainAfterCurrent = false;
            void saveCurrentDocument();
        }
    }

    return saved;
}

async function resolveSavePath(options: SaveDocumentOptions): Promise<string | null> {
    if (!options.promptForPath && documentState.activeFilePath) {
        return resolveEditedActiveFilePath(
            documentState.activeFilePath,
            getElement<HTMLInputElement>("document-title").value,
            getDocumentFormatById(documentState.activeFormatId).defaultExtension,
        );
    }

    const selectedPath = await chooseDocumentToSave(
        normalizeSuggestedFileName(
            options.suggestedFileName ??
                (documentState.activeFilePath ? fileNameFromPath(documentState.activeFilePath) : null) ??
                getDocumentFormatById(documentState.activeFormatId).defaultFileName,
            getDocumentFormatById(documentState.activeFormatId).defaultExtension,
        ),
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
