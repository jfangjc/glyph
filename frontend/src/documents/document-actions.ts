import { chooseDocumentToOpen, chooseDocumentToSave, readDocument, saveDocument } from "../bridge/documents";
import type { DocumentFile } from "../bridge/types";
import { getDocumentFormatById } from "../formats/registry";
import { fileNameFromPath } from "../utils/text";
import { documentState, notifyDocumentStateChanged } from "./document-state";

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

export function bindDocumentActions(nextHost: DocumentActionHost): void {
    host = nextHost;
    documentState.lastSavedContent = nextHost.serializeDocument();
    notifyDocumentStateChanged();
}

export function startDocumentAutosave(): void {
    window.setInterval(() => void saveCurrentDocument(), autoSaveIntervalMs);
}

export function canUseDesktopFileSystem(): boolean {
    return Boolean((window as Window & { _wails?: { environment?: unknown } })._wails?.environment);
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
    } catch (error) {
        console.error("Failed to open file:", error);
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

    if (content === documentState.lastSavedContent && !options.promptForPath) {
        documentState.hasUnsavedChanges = false;
        notifyDocumentStateChanged();
        return true;
    }

    documentState.isSavingDocument = true;
    notifyDocumentStateChanged();
    let saved = false;

    try {
        await saveDocument(path, content);

        if (documentState.activeFilePath === previousPath || options.promptForPath) {
            documentState.activeFilePath = path;
            documentState.lastSavedContent = content;
            documentState.hasUnsavedChanges = getHost().serializeDocument() !== documentState.lastSavedContent;
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
        return documentState.activeFilePath;
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

function normalizeSuggestedFileName(value: string, defaultExtension: string): string {
    const trimmed = value.trim() || "Untitled";

    if (/[\\/]$/.test(trimmed)) {
        return `Untitled.${defaultExtension}`;
    }

    return /\.[^\\/.\s]+$/.test(trimmed) ? trimmed : `${trimmed}.${defaultExtension}`;
}

function getHost(): DocumentActionHost {
    if (!host) {
        throw new Error("Document actions have not been bound");
    }

    return host;
}
