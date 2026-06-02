import type { DocumentFile } from "../bridge/types";
import { readEditorDom } from "../editor/editor-dom";
import { clearEditorHistory } from "../editor/history/undo-history";
import { getDocumentFormatById, getDocumentFormatForPath } from "../formats/registry";
import type { DocumentFormat } from "../formats/types";
import {
    applyDocumentRenderContext,
    loadDocumentRenderContext,
    replaceEditorBlocks,
    scheduleDocumentReferenceSync,
    serializeDocumentBlocks,
    syncBlockViewContext as syncRenderBlockViewContext,
    syncDocumentFooter,
    syncDocumentReferences,
} from "./document-render-context";
import { syncDocumentPreview } from "./document-preview";
import { documentState, markDocumentDirty, notifyDocumentStateChanged } from "./document-state";

export function getActiveDocumentFormat(): DocumentFormat {
    return getDocumentFormatById(documentState.activeFormatId);
}

export function loadDocument(documentFile: DocumentFile): void {
    const format = getDocumentFormatForPath(documentFile.path || documentFile.name);
    const parsedDocument = format.parseDocument(documentFile);
    const { title } = readEditorDom();

    documentState.activeFilePath = documentFile.path;
    documentState.activeFormatId = format.id;
    documentState.usesTitle = format.supportsTitle && parsedDocument.usesTitle;
    loadDocumentRenderContext(format, parsedDocument.blocks, parsedDocument.references ?? {});
    syncDocumentFormatUi();
    syncBlockViewContext();
    title.value = parsedDocument.title;
    replaceEditorBlocks(parsedDocument.blocks);
    syncDocumentReferences(format, documentState.activeFilePath);
    applyDocumentRenderContext(format);
    syncDocumentFooter(format);
    clearEditorHistory();
    documentState.lastSavedContent = serializeDocument();
    documentState.hasUnsavedChanges = false;
    notifyDocumentStateChanged();
}

export function serializeDocument(): string {
    const { title } = readEditorDom();
    const format = getActiveDocumentFormat();

    return format.serializeDocument(
        format.supportsTitle ? title.value : "",
        format.supportsTitle && documentState.usesTitle,
        serializeDocumentBlocks(format, documentState.activeFilePath),
    );
}

export function markEditorDirty(): void {
    scheduleDocumentReferenceSync(getActiveDocumentFormat, () => documentState.activeFilePath);
    markDocumentDirty();
}

export function syncEditorDirtyState(): void {
    documentState.hasUnsavedChanges = serializeDocument() !== documentState.lastSavedContent;
    notifyDocumentStateChanged();
}

export function syncBlockViewContext(): void {
    syncRenderBlockViewContext(getActiveDocumentFormat(), documentState.activeFilePath);
}

export function syncDocumentFormatUi(): void {
    const { shell, surface, title } = readEditorDom();
    const format = getActiveDocumentFormat();

    title.hidden = !format.supportsTitle;
    surface.dataset.documentFormat = format.id;
    shell.dataset.documentFormat = format.id;

    syncDocumentPreview(format, {
        activeFilePath: documentState.activeFilePath,
        isSavingDocument: documentState.isSavingDocument,
    });
    syncDocumentFooter(format);
}
