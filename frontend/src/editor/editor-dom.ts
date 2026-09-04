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
        markdownModeToggle: getElement<HTMLButtonElement>("markdown-mode-toggle"),
        footer: getElement<HTMLElement>("document-render-footer"),
        latexPreview: getElement<HTMLElement>("latex-preview"),
        latexFrame: getElement<HTMLIFrameElement>("latex-pdf-frame"),
        latexStatus: getElement<HTMLElement>("latex-preview-status"),
    };
}
