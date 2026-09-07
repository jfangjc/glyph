export type DocumentEditingMode = "live-preview" | "source";

type DocumentState = {
    sessionId: number;
    activeFilePath: string | null;
    activeFormatId: string;
    editingMode: DocumentEditingMode;
    fileName: string;
    committedFileName: string;
    fileNameDirty: boolean;
    lineEnding: "\n" | "\r\n";
    hasUtf8Bom: boolean;
    hasUnsavedChanges: boolean;
    isOpeningDocument: boolean;
    isSavingDocument: boolean;
    saveAgainAfterCurrent: boolean;
    lastSavedContent: string;
    lastSavedSource: string;
};

export const documentStateChangedEvent = "glyph:document-state-changed";

export const documentState: DocumentState = {
    sessionId: 0,
    activeFilePath: null,
    activeFormatId: "markdown",
    editingMode: "live-preview",
    fileName: "Untitled.md",
    committedFileName: "Untitled.md",
    fileNameDirty: false,
    lineEnding: "\n",
    hasUtf8Bom: false,
    hasUnsavedChanges: false,
    isOpeningDocument: false,
    isSavingDocument: false,
    saveAgainAfterCurrent: false,
    lastSavedContent: "",
    lastSavedSource: "",
};

export function recordSavedDocumentContent(content: string): void {
    documentState.lastSavedContent = content;
    const source = documentState.hasUtf8Bom ? content.slice(1) : content;
    documentState.lastSavedSource = documentState.lineEnding === "\r\n"
        ? source.replace(/\r\n/g, "\n")
        : source;
}

let notifiedMetadata: unknown[] = [];

export function beginDocumentSession(options: {
    path: string | null;
    formatId: string;
    fileName: string;
    lineEnding?: "\n" | "\r\n";
    hasUtf8Bom?: boolean;
}): number {
    documentState.sessionId += 1;
    documentState.activeFilePath = options.path;
    documentState.activeFormatId = options.formatId;
    documentState.editingMode = "live-preview";
    documentState.fileName = options.fileName;
    documentState.committedFileName = options.fileName;
    documentState.fileNameDirty = false;
    documentState.lineEnding = options.lineEnding ?? "\n";
    documentState.hasUtf8Bom = options.hasUtf8Bom ?? false;
    return documentState.sessionId;
}

export function notifyDocumentStateChanged(): void {
    // Saved bytes/source belong to content comparison, not UI metadata.
    const { lastSavedContent, lastSavedSource, ...metadata } = documentState;
    const values = Object.values(metadata);
    if (values.every((value, index) => value === notifiedMetadata[index])) {
        return;
    }
    notifiedMetadata = values;
    window.dispatchEvent(new CustomEvent(documentStateChangedEvent));
}
