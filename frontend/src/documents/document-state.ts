type DocumentState = {
    activeFilePath: string | null;
    activeFormatId: string;
    usesTitle: boolean;
    hasUnsavedChanges: boolean;
    isOpeningDocument: boolean;
    isSavingDocument: boolean;
    saveAgainAfterCurrent: boolean;
    lastSavedContent: string;
};

export const documentStateChangedEvent = "glyph:document-state-changed";

export const documentState: DocumentState = {
    activeFilePath: null,
    activeFormatId: "markdown",
    usesTitle: false,
    hasUnsavedChanges: false,
    isOpeningDocument: false,
    isSavingDocument: false,
    saveAgainAfterCurrent: false,
    lastSavedContent: "",
};

export function markDocumentDirty(): void {
    documentState.hasUnsavedChanges = true;
    notifyDocumentStateChanged();
}

export function notifyDocumentStateChanged(): void {
    window.dispatchEvent(new CustomEvent(documentStateChangedEvent));
}
