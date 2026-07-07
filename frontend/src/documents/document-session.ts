import type { DocumentFile } from "../bridge/types";
import {
    clearSourceHistory,
    getEditorState,
    getMarkdownSource,
    replaceDocumentSource,
    subscribeEditorState,
} from "../editor/core/store";
import { syncDomSelectionFromState } from "../editor/core/projection";
import { readEditorDom } from "../editor/editor-dom";
import { clearEditorHistory } from "../editor/history/undo-history";
import { getDocumentFormatById, getDocumentFormatForPath } from "../formats/registry";
import type { DocumentFormat } from "../formats/types";
import {
    applyDocumentRenderContext,
    loadDocumentRenderContext,
    readParsedBlocksFromSourceState,
    replaceEditorBlocks,
    replaceEditorBlocksFromSourceState,
    scheduleDocumentReferenceSync,
    serializeDocumentBlocks,
    syncBlockViewContext as syncRenderBlockViewContext,
    syncDocumentFooter,
    syncDocumentReferences,
} from "./document-render-context";
import { syncDocumentPreview } from "./document-preview";
import { documentState, markDocumentDirty, notifyDocumentStateChanged } from "./document-state";

let sourceStateIntegrationInstalled = false;

export function getActiveDocumentFormat(): DocumentFormat {
    return getDocumentFormatById(documentState.activeFormatId);
}

export function installSourceStateDocumentIntegration(): void {
    if (sourceStateIntegrationInstalled) {
        return;
    }

    sourceStateIntegrationInstalled = true;
    subscribeEditorState((next, previous) => {
        if (documentState.activeFormatId !== "markdown" || next.doc === previous.doc) {
            return;
        }

        syncMarkdownProjectionFromState(next);
        documentState.hasUnsavedChanges = next.doc !== documentState.lastSavedContent;
        notifyDocumentStateChanged();
    });
}

export function loadDocument(documentFile: DocumentFile): void {
    const format = getDocumentFormatForPath(documentFile.path || documentFile.name);
    if (format.id === "markdown") {
        loadMarkdownDocument(documentFile, format);
        return;
    }

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
    if (documentState.activeFormatId === "markdown") {
        return getMarkdownSource();
    }

    const { title } = readEditorDom();
    const format = getActiveDocumentFormat();

    return format.serializeDocument(
        format.supportsTitle ? title.value : "",
        format.supportsTitle && documentState.usesTitle,
        serializeDocumentBlocks(format, documentState.activeFilePath),
    );
}

export function markEditorDirty(): void {
    if (documentState.activeFormatId === "markdown") {
        syncEditorDirtyState();
        return;
    }

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

function loadMarkdownDocument(documentFile: DocumentFile, format: DocumentFormat): void {
    const parsedDocument = format.parseDocument(documentFile);
    const { title } = readEditorDom();

    documentState.activeFilePath = documentFile.path;
    documentState.activeFormatId = format.id;
    documentState.usesTitle = format.supportsTitle && parsedDocument.usesTitle;
    title.value = parsedDocument.title;

    replaceDocumentSource(documentFile.content, { anchor: 0, head: 0 }, {
        userEvent: "programmatic",
        addToHistory: false,
    });
    syncMarkdownProjectionFromState(getEditorState());
    clearSourceHistory();
    clearEditorHistory();
    documentState.lastSavedContent = getMarkdownSource();
    documentState.hasUnsavedChanges = false;
    syncDocumentFormatUi();
    notifyDocumentStateChanged();
}

function syncMarkdownProjectionFromState(state: ReturnType<typeof getEditorState>): void {
    const format = getActiveDocumentFormat();
    const blocks = readParsedBlocksFromSourceState(state);

    loadDocumentRenderContext(format, blocks, format.readReferences?.(blocks) ?? {});
    syncRenderBlockViewContext(format, documentState.activeFilePath);
    replaceEditorBlocksFromSourceState(state);
    applyDocumentRenderContext(format);
    syncDocumentFooter(format);
    syncDocumentPreview(format, {
        activeFilePath: documentState.activeFilePath,
        isSavingDocument: documentState.isSavingDocument,
    });
    syncDomSelectionFromState();
}
