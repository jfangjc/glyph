import { readSiblingPdfPreview } from "../bridge/documents";
import type { DocumentFile } from "../bridge/types";
import {
    configureBlockView,
    createBlock,
    findBlock,
    getBlockText,
    getEditorBlocks,
    getSerializableEditorBlocks,
    isRichTextBlockType,
    readEditorBlock,
    setBlockText,
    syncFirstBlockPlaceholder,
} from "../editor/blocks/view";
import { readBlockType, type ParsedBlock } from "../editor/blocks/model";
import { focusBlockAtOffset, getCurrentBlockOffset } from "../editor/selection/caret";
import { getElement } from "../utils/dom";
import { clearEditorHistory } from "../editor/history/undo-history";
import { commitActiveBlockMarkdownSource } from "../formats/markdown/editor/source-controller";
import { getDocumentFormatById, getDocumentFormatForPath } from "../formats/registry";
import type { DocumentFormat, DocumentReferenceMap } from "../formats/types";
import { documentState, markDocumentDirty, notifyDocumentStateChanged } from "./document-state";

let documentReferences: DocumentReferenceMap = {};
let documentReferencesSnapshot = "{}";
let referenceRerenderRequestId = 0;
let latexPreviewSourcePath: string | null = null;
let latexPreviewRequestId = 0;
let wasSavingDocumentForLatexPreview = false;

export function getActiveDocumentFormat(): DocumentFormat {
    return getDocumentFormatById(documentState.activeFormatId);
}

export function loadDocument(documentFile: DocumentFile): void {
    const format = getDocumentFormatForPath(documentFile.path || documentFile.name);
    const parsedDocument = format.parseDocument(documentFile);
    const title = getElement<HTMLInputElement>("document-title");

    documentState.activeFilePath = documentFile.path;
    documentState.activeFormatId = format.id;
    documentState.usesTitle = format.supportsTitle && parsedDocument.usesTitle;
    documentReferences = parsedDocument.references ?? {};
    documentReferencesSnapshot = JSON.stringify(documentReferences);
    syncDocumentFormatUi();
    syncBlockViewContext();
    title.value = parsedDocument.title;
    replaceEditorBlocks(parsedDocument.blocks);
    clearEditorHistory();
    documentState.lastSavedContent = serializeDocument();
    documentState.hasUnsavedChanges = false;
    notifyDocumentStateChanged();
}

export function serializeDocument(): string {
    commitActiveBlockMarkdownSource();
    const title = getElement<HTMLInputElement>("document-title").value;
    const format = getActiveDocumentFormat();

    return format.serializeDocument(
        format.supportsTitle ? title : "",
        format.supportsTitle && documentState.usesTitle,
        getSerializableEditorBlocks().map(readEditorBlock),
    );
}

export function markEditorDirty(): void {
    syncDocumentReferences();
    markDocumentDirty();
}

export function syncBlockViewContext(): void {
    const format = getActiveDocumentFormat();

    configureBlockView({
        references: documentReferences,
        activeFilePath: documentState.activeFilePath,
        renderInlineContent: format.renderInline,
        renderPlainTextContent: format.renderPlainTextContent,
        renderBlockContent: format.renderBlock,
        hydrateRenderedContent: format.hydrateRenderedContent,
        readBlockSource: format.readBlockSource,
    });
}

export function syncDocumentFormatUi(): void {
    const title = getElement<HTMLInputElement>("document-title");
    const surface = getElement<HTMLElement>("document-surface");
    const shell = document.querySelector<HTMLElement>(".editor-shell");
    const format = getActiveDocumentFormat();

    title.hidden = !format.supportsTitle;
    surface.dataset.documentFormat = format.id;
    if (shell) {
        shell.dataset.documentFormat = format.id;
    }

    syncLatexPdfPreview(format.id === "latex");
}

function syncLatexPdfPreview(isLatexDocument: boolean): void {
    const preview = getElement<HTMLElement>("latex-preview");
    const frame = getElement<HTMLIFrameElement>("latex-pdf-frame");
    const status = getElement<HTMLElement>("latex-preview-status");
    const saveJustFinished = wasSavingDocumentForLatexPreview && !documentState.isSavingDocument;

    wasSavingDocumentForLatexPreview = documentState.isSavingDocument;

    if (!isLatexDocument) {
        latexPreviewRequestId += 1;
        latexPreviewSourcePath = null;
        setLatexPreviewActive(false);
        preview.dataset.state = "hidden";
        frame.removeAttribute("src");
        status.textContent = "";
        return;
    }

    if (!documentState.activeFilePath) {
        latexPreviewRequestId += 1;
        latexPreviewSourcePath = null;
        setLatexPreviewActive(false);
        preview.dataset.state = "empty";
        frame.removeAttribute("src");
        status.textContent = "";
        return;
    }

    if (documentState.activeFilePath === latexPreviewSourcePath && !saveJustFinished) {
        return;
    }

    void loadLatexPdfPreview(documentState.activeFilePath);
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
        if (requestId !== latexPreviewRequestId || documentState.activeFilePath !== sourcePath) {
            return;
        }

        setLatexPreviewActive(true);
        frame.src = `${pdfPreview.dataUrl}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`;
        preview.dataset.state = "ready";
        status.textContent = "";
    } catch {
        if (requestId !== latexPreviewRequestId || documentState.activeFilePath !== sourcePath) {
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

function syncDocumentReferences(): void {
    const nextReferences = getActiveDocumentFormat().readReferences?.(getEditorBlocks().map(readEditorBlock)) ?? {};
    const nextReferencesSnapshot = JSON.stringify(nextReferences);
    if (nextReferencesSnapshot === documentReferencesSnapshot) {
        return;
    }

    documentReferences = nextReferences;
    documentReferencesSnapshot = nextReferencesSnapshot;
    syncBlockViewContext();
    rerenderInlineContentBlocks();
}

function rerenderInlineContentBlocks(): void {
    const requestId = referenceRerenderRequestId + 1;
    referenceRerenderRequestId = requestId;

    const selection = document.getSelection();
    const activeBlock = findBlock(selection?.focusNode ?? null);
    const activeOffset = activeBlock ? getCurrentBlockOffset(activeBlock) : null;
    const richTextBlocks = getEditorBlocks().filter((block) => isRichTextBlockType(readBlockType(block.dataset.type)));

    if (richTextBlocks.length <= 100) {
        for (const block of richTextBlocks) {
            setBlockText(block, getBlockText(block));
        }

        restoreActiveBlockFocus(activeBlock, activeOffset);
        return;
    }

    if (activeBlock && richTextBlocks.includes(activeBlock)) {
        setBlockText(activeBlock, getBlockText(activeBlock));
        restoreActiveBlockFocus(activeBlock, activeOffset);
    }

    const remainingBlocks = richTextBlocks.filter((block) => block !== activeBlock);
    rerenderInlineContentBlocksInChunks(remainingBlocks, requestId);
}

function rerenderInlineContentBlocksInChunks(blocks: HTMLElement[], requestId: number): void {
    const chunkSize = 50;
    let cursor = 0;

    const renderNextChunk = () => {
        if (requestId !== referenceRerenderRequestId) {
            return;
        }

        const end = Math.min(blocks.length, cursor + chunkSize);
        for (; cursor < end; cursor += 1) {
            const block = blocks[cursor];
            if (block.isConnected) {
                setBlockText(block, getBlockText(block));
            }
        }

        if (cursor < blocks.length) {
            window.requestAnimationFrame(renderNextChunk);
        }
    };

    window.requestAnimationFrame(renderNextChunk);
}

function restoreActiveBlockFocus(activeBlock: HTMLElement | null, activeOffset: number | null): void {
    if (activeBlock?.isConnected && activeOffset !== null) {
        focusBlockAtOffset(activeBlock, Math.min(activeOffset, getBlockText(activeBlock).length), { scroll: "none" });
    }
}

function replaceEditorBlocks(blocks: ParsedBlock[]): void {
    const editor = getElement<HTMLElement>("editor");
    const nextBlocks = blocks.map((block) => createBlock(block.type, block.text, block));

    editor.replaceChildren(...nextBlocks);
    syncFirstBlockPlaceholder();
    focusBlockAtOffset(nextBlocks[0], 0);
}
