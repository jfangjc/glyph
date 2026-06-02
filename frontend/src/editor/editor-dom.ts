import { getElement } from "../utils/dom";

export type EditorDom = {
    shell: HTMLElement;
    surface: HTMLElement;
    editor: HTMLElement;
    title: HTMLInputElement;
    footer: HTMLElement;
    latexPreview: HTMLElement;
    latexFrame: HTMLIFrameElement;
    latexStatus: HTMLElement;
    findReplacePanel: HTMLElement;
    findQuery: HTMLInputElement;
    replaceQuery: HTMLInputElement;
    findCounter: HTMLElement;
    findPrevious: HTMLButtonElement;
    findNext: HTMLButtonElement;
    findCaseSensitive: HTMLButtonElement;
    findWholeWord: HTMLButtonElement;
    findReplaceToggle: HTMLButtonElement;
    replaceCurrent: HTMLButtonElement;
    replaceAll: HTMLButtonElement;
    findClose: HTMLButtonElement;
    findHighlightLayer: HTMLElement;
};

export function readEditorDom(): EditorDom {
    const shell = document.querySelector<HTMLElement>(".editor-shell");
    if (!shell) {
        throw new Error("Editor shell is missing");
    }

    return {
        shell,
        surface: getElement<HTMLElement>("document-surface"),
        editor: getElement<HTMLElement>("editor"),
        title: getElement<HTMLInputElement>("document-title"),
        footer: getElement<HTMLElement>("document-render-footer"),
        latexPreview: getElement<HTMLElement>("latex-preview"),
        latexFrame: getElement<HTMLIFrameElement>("latex-pdf-frame"),
        latexStatus: getElement<HTMLElement>("latex-preview-status"),
        findReplacePanel: getElement<HTMLElement>("find-replace-panel"),
        findQuery: getElement<HTMLInputElement>("find-query"),
        replaceQuery: getElement<HTMLInputElement>("replace-query"),
        findCounter: getElement<HTMLElement>("find-counter"),
        findPrevious: getElement<HTMLButtonElement>("find-previous"),
        findNext: getElement<HTMLButtonElement>("find-next"),
        findCaseSensitive: getElement<HTMLButtonElement>("find-case-sensitive"),
        findWholeWord: getElement<HTMLButtonElement>("find-whole-word"),
        findReplaceToggle: getElement<HTMLButtonElement>("find-replace-toggle"),
        replaceCurrent: getElement<HTMLButtonElement>("replace-current"),
        replaceAll: getElement<HTMLButtonElement>("replace-all"),
        findClose: getElement<HTMLButtonElement>("find-close"),
        findHighlightLayer: getElement<HTMLElement>("find-highlight-layer"),
    };
}
