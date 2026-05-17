export type DocumentState = {
    activeFilePath: string | null;
    usesTitle: boolean;
    hasUnsavedChanges: boolean;
    isOpeningDocument: boolean;
    isSavingDocument: boolean;
    saveAgainAfterCurrent: boolean;
    lastSavedMarkdown: string;
};

export const documentStateChangedEvent = "glyph:document-state-changed";

export const documentState: DocumentState = {
    activeFilePath: null,
    usesTitle: false,
    hasUnsavedChanges: false,
    isOpeningDocument: false,
    isSavingDocument: false,
    saveAgainAfterCurrent: false,
    lastSavedMarkdown: "",
};

export function markDocumentDirty(): void {
    documentState.hasUnsavedChanges = true;
    notifyDocumentStateChanged();
}

export function notifyDocumentStateChanged(): void {
    window.dispatchEvent(new CustomEvent(documentStateChangedEvent));
}
