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
    subscribeEditorState((next, previous, transaction) => {
        if (documentState.activeFormatId !== "markdown" || next.doc === previous.doc) {
            return;
        }

        syncMarkdownProjectionFromState(next, previous, transaction);
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

function syncMarkdownProjectionFromState(
    state: ReturnType<typeof getEditorState>,
    previous?: ReturnType<typeof getEditorState>,
    transaction?: Parameters<Parameters<typeof subscribeEditorState>[0]>[2],
): void {
    const projectionStartedAt = readPerformanceNow();
    const format = getActiveDocumentFormat();
    const refreshRenderContext = shouldRefreshMarkdownRenderContext(state, previous, transaction);
    const renderContextStartedAt = readPerformanceNow();
    const blocks = refreshRenderContext ? readParsedBlocksFromSourceState(state) : null;
    const renderContextChanged = blocks
        ? loadDocumentRenderContext(format, blocks, format.readReferences?.(blocks) ?? {})
        : false;
    measureEditorPerformance("glyph:render-context", renderContextStartedAt);
    if (renderContextChanged) {
        syncRenderBlockViewContext(format, documentState.activeFilePath);
    }
    replaceEditorBlocksFromSourceState(state, previous);
    if (renderContextChanged) {
        applyDocumentRenderContext(format);
        syncDocumentFooter(format);
        syncDocumentPreview(format, {
            activeFilePath: documentState.activeFilePath,
            isSavingDocument: documentState.isSavingDocument,
        });
    }
    const selectionStartedAt = readPerformanceNow();
    syncDomSelectionFromState();
    measureEditorPerformance("glyph:selection-restoration", selectionStartedAt);
    measureEditorPerformance("glyph:projection", projectionStartedAt);
}

function readPerformanceNow(): number {
    return typeof performance === "undefined" ? 0 : performance.now();
}

function measureEditorPerformance(name: string, startedAt: number): void {
    if (!import.meta.env.DEV || typeof performance === "undefined") {
        return;
    }
    performance.measure(name, { start: startedAt, end: performance.now() });
    if (performance.getEntriesByName(name).length > 100) {
        performance.clearMeasures(name);
    }
}

function shouldRefreshMarkdownRenderContext(
    state: ReturnType<typeof getEditorState>,
    previous: ReturnType<typeof getEditorState> | undefined,
    transaction: Parameters<Parameters<typeof subscribeEditorState>[0]>[2] | undefined,
): boolean {
    if (!previous || !transaction) {
        return true;
    }

    const contextTypes = new Set(["reference", "footnote-definition"]);
    for (const change of transaction.changes) {
        const removed = previous.doc.slice(change.from, change.to);
        if (/[\n#\[\]<>`$|:]/.test(change.insert + removed)) {
            return true;
        }

        const previousBlock = previous.blocks.blocks.find((block) => change.from <= block.sourceTo && change.to >= block.sourceFrom);
        const nextBlock = state.blocks.blocks.find((block) => change.from <= block.sourceTo);
        if (
            previousBlock?.type.startsWith("heading-") ||
            nextBlock?.type.startsWith("heading-") ||
            previousBlock && contextTypes.has(previousBlock.type) ||
            nextBlock && contextTypes.has(nextBlock.type)
        ) {
            return true;
        }
    }

    return false;
}
