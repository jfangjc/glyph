import { chooseDocumentToOpen, chooseDocumentToSave, readDocument, renameDocument, saveDocument } from "../bridge/documents";
import type { DocumentFile } from "../bridge/types";
import { getDocumentFormatById } from "../formats/registry";
import { titleFromFileName } from "../formats/file-names";
import { getElement } from "../utils/dom";
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
const lastOpenDocumentPathStorageKey = "glyph:last-open-document-path";

let host: DocumentActionHost | null = null;

export function bindDocumentActions(nextHost: DocumentActionHost): void {
    host = nextHost;
    documentState.lastSavedContent = nextHost.serializeDocument();
    notifyDocumentStateChanged();
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

export function canUseDesktopFileSystem(): boolean {
    return Boolean(
        (window as Window & { _wails?: { environment?: unknown } })._wails?.environment ||
            (window as Window & { chrome?: { webview?: { postMessage?: unknown } } }).chrome?.webview?.postMessage ||
            (window as Window & { webkit?: { messageHandlers?: { external?: { postMessage?: unknown } } } }).webkit
                ?.messageHandlers?.external?.postMessage ||
            (window as Window & { wails?: { invoke?: unknown } }).wails?.invoke,
    );
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
        return resolveEditedActiveFilePath(documentState.activeFilePath);
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

function resolveEditedActiveFilePath(activeFilePath: string): string {
    const currentFileName = fileNameFromPath(activeFilePath);
    const title = getElement<HTMLInputElement>("document-title").value.trim();

    if (!title || title === titleFromFileName(currentFileName)) {
        return activeFilePath;
    }

    const extension = readFileExtension(currentFileName) ?? getDocumentFormatById(documentState.activeFormatId).defaultExtension;
    const nextFileName = normalizeSuggestedFileName(sanitizeFileNameBase(title), extension);
    const separatorIndex = Math.max(activeFilePath.lastIndexOf("\\"), activeFilePath.lastIndexOf("/"));

    return separatorIndex >= 0 ? `${activeFilePath.slice(0, separatorIndex + 1)}${nextFileName}` : nextFileName;
}

function normalizeSuggestedFileName(value: string, defaultExtension: string): string {
    const trimmed = value.trim() || "Untitled";

    if (/[\\/]$/.test(trimmed)) {
        return `Untitled.${defaultExtension}`;
    }

    return /\.[^\\/.\s]+$/.test(trimmed) ? trimmed : `${trimmed}.${defaultExtension}`;
}

function sanitizeFileNameBase(value: string): string {
    return value
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
        .replace(/\s+/g, " ")
        .replace(/[. ]+$/g, "")
        .slice(0, 80)
        .trim();
}

function readFileExtension(fileName: string): string | null {
    const extensionMatch = fileName.match(/\.([^\\/.\s]+)$/);
    return extensionMatch?.[1] ?? null;
}

function areSamePath(left: string, right: string): boolean {
    return normalizeComparablePath(left) === normalizeComparablePath(right);
}

function normalizeComparablePath(path: string): string {
    return path.replace(/\\/g, "/").toLowerCase();
}

function getLastOpenDocumentPath(): string | null {
    return window.localStorage.getItem(lastOpenDocumentPathStorageKey);
}

function rememberLastOpenDocumentPath(path: string): void {
    window.localStorage.setItem(lastOpenDocumentPathStorageKey, path);
}

function forgetLastOpenDocumentPath(): void {
    window.localStorage.removeItem(lastOpenDocumentPathStorageKey);
}

function getHost(): DocumentActionHost {
    if (!host) {
        throw new Error("Document actions have not been bound");
    }

    return host;
}
