import { readSiblingPdfPreview } from "../../bridge/documents";
import { getElement } from "../../utils/dom";
import type { DocumentPreviewBehavior, DocumentPreviewContext } from "../types";

let latexPreviewSourcePath: string | null = null;
let latexPreviewRequestId = 0;
let wasSavingDocumentForLatexPreview = false;

export const latexPreviewBehavior: DocumentPreviewBehavior = {
    sync: syncLatexPdfPreview,
    deactivate: deactivateLatexPdfPreview,
};

function syncLatexPdfPreview(context: DocumentPreviewContext): void {
    const preview = getElement<HTMLElement>("latex-preview");
    const frame = getElement<HTMLIFrameElement>("latex-pdf-frame");
    const status = getElement<HTMLElement>("latex-preview-status");
    const saveJustFinished = wasSavingDocumentForLatexPreview && !context.isSavingDocument;

    wasSavingDocumentForLatexPreview = context.isSavingDocument;

    if (!context.activeFilePath) {
        latexPreviewRequestId += 1;
        latexPreviewSourcePath = null;
        setLatexPreviewActive(false);
        preview.dataset.state = "empty";
        frame.removeAttribute("src");
        status.textContent = "";
        return;
    }

    if (context.activeFilePath === latexPreviewSourcePath && !saveJustFinished) {
        return;
    }

    void loadLatexPdfPreview(context.activeFilePath);
}

function deactivateLatexPdfPreview(_context: DocumentPreviewContext): void {
    const preview = getElement<HTMLElement>("latex-preview");
    const frame = getElement<HTMLIFrameElement>("latex-pdf-frame");
    const status = getElement<HTMLElement>("latex-preview-status");

    latexPreviewRequestId += 1;
    latexPreviewSourcePath = null;
    wasSavingDocumentForLatexPreview = false;
    setLatexPreviewActive(false);
    preview.dataset.state = "hidden";
    frame.removeAttribute("src");
    status.textContent = "";
}

async function loadLatexPdfPreview(sourcePath: string): Promise<void> {
    const requestId = latexPreviewRequestId + 1;
    const preview = getElement<HTMLElement>("latex-preview");
    const frame = getElement<HTMLIFrameElement>("latex-pdf-frame");
    const status = getElement<HTMLElement>("latex-preview-status");

    latexPreviewRequestId = requestId;
    latexPreviewSourcePath = sourcePath;
    setLatexPreviewActive(true);
    preview.dataset.state = "loading";
    frame.removeAttribute("src");
    status.textContent = "Preparing PDF preview...";

    try {
        const pdfPreview = await readSiblingPdfPreview(sourcePath);
        if (requestId !== latexPreviewRequestId) {
            return;
        }

        setLatexPreviewActive(true);
        frame.src = `${pdfPreview.dataUrl}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`;
        preview.dataset.state = "ready";
        status.textContent = "";
    } catch {
        if (requestId !== latexPreviewRequestId) {
            return;
        }

        preview.dataset.state = "unavailable";
        setLatexPreviewActive(false);
        frame.removeAttribute("src");
        status.textContent = "";
    }
}

function setLatexPreviewActive(isActive: boolean): void {
    const surface = getElement<HTMLElement>("document-surface");
    const shell = document.querySelector<HTMLElement>(".editor-shell");

    if (isActive) {
        surface.dataset.latexPreview = "active";
        if (shell) {
            shell.dataset.latexPreview = "active";
        }
        return;
    }

    delete surface.dataset.latexPreview;
    if (shell) {
        delete shell.dataset.latexPreview;
    }
}
