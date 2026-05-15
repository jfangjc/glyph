import { chooseDocumentToOpen, readDocument, saveDocument } from "../bridge/documents";
import type { DocumentFile } from "../bridge/types";
import { documentState } from "./document-state";

type DocumentActionHost = {
    loadDocument: (documentFile: DocumentFile) => void;
    serializeDocumentMarkdown: () => string;
};

const autoSaveIntervalMs = 30_000;

let host: DocumentActionHost | null = null;

export function bindDocumentActions(nextHost: DocumentActionHost): void {
    host = nextHost;
    documentState.lastSavedMarkdown = nextHost.serializeDocumentMarkdown();
}

export function startDocumentAutosave(): number {
    return window.setInterval(() => void saveCurrentDocument(), autoSaveIntervalMs);
}

export async function openDocument(): Promise<void> {
    if (documentState.isOpeningDocument) {
        return;
    }

    documentState.isOpeningDocument = true;

    try {
        if (documentState.activeFilePath && documentState.hasUnsavedChanges && !(await saveCurrentDocument())) {
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
    }
}

export async function saveCurrentDocument(): Promise<boolean> {
    if (!documentState.activeFilePath || !documentState.hasUnsavedChanges) {
        return true;
    }

    if (documentState.isSavingDocument) {
        documentState.saveAgainAfterCurrent = true;
        return false;
    }

    const path = documentState.activeFilePath;
    const content = getHost().serializeDocumentMarkdown();

    if (content === documentState.lastSavedMarkdown) {
        documentState.hasUnsavedChanges = false;
        return true;
    }

    documentState.isSavingDocument = true;
    let saved = false;

    try {
        await saveDocument(path, content);

        if (documentState.activeFilePath === path) {
            documentState.lastSavedMarkdown = content;
            documentState.hasUnsavedChanges = getHost().serializeDocumentMarkdown() !== documentState.lastSavedMarkdown;
        }

        saved = !documentState.hasUnsavedChanges;
    } catch (error) {
        console.error("Failed to autosave file:", error);
    } finally {
        documentState.isSavingDocument = false;

        if (documentState.saveAgainAfterCurrent) {
            documentState.saveAgainAfterCurrent = false;
            void saveCurrentDocument();
        }
    }

    return saved;
}

function getHost(): DocumentActionHost {
    if (!host) {
        throw new Error("Document actions have not been bound");
    }

    return host;
}
