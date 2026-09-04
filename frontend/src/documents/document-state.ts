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
};

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
    window.dispatchEvent(new CustomEvent(documentStateChangedEvent));
}
