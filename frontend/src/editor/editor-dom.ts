import { getElement } from "../utils/dom";

export function readEditorDom() {
    const shell = document.querySelector<HTMLElement>(".editor-shell");
    if (!shell) {
        throw new Error("Editor shell is missing");
    }

    return {
        shell,
        surface: getElement<HTMLElement>("document-surface"),
        editor: getElement<HTMLElement>("editor"),
        title: getElement<HTMLInputElement>("document-title"),
        extension: getElement<HTMLElement>("document-extension"),
        editingModeToggle: getElement<HTMLButtonElement>("editing-mode-toggle"),
        footer: getElement<HTMLElement>("document-render-footer"),
        preview: getElement<HTMLElement>("document-preview"),
        previewFrame: getElement<HTMLIFrameElement>("document-pdf-frame"),
        previewStatus: getElement<HTMLElement>("document-preview-status"),
    };
}
