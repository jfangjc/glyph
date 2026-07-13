import type { DocumentFile } from "../bridge/types";
import { syncDocumentWindowTitle } from "../app/window-title";
import {
    clearSourceHistory,
    configureBlockIndexBuilder,
    getEditorState,
    getDocumentSource,
    measureEditorPerformance,
    readPerformanceNow,
    replaceDocumentState,
    subscribeEditorState,
} from "../editor/core/store";
import { configureProjectionCapability, syncDomSelectionFromState } from "../editor/core/projection";
import { readEditorDom } from "../editor/editor-dom";
import { getDocumentFormatById, getDocumentFormatForPath } from "../formats/registry";
import { titleFromFileName } from "../formats/file-names";
import type { DocumentFormat } from "../formats/types";
import {
    applyDocumentRenderContext,
    loadDocumentRenderContext,
    readParsedBlocksFromSourceState,
    replaceEditorBlocksFromSourceState,
    syncBlockViewContext as syncRenderBlockViewContext,
    syncDocumentFooter,
    syncDocumentReferences,
} from "./document-render-context";
import { syncDocumentPreview } from "./document-preview";
import { documentState, notifyDocumentStateChanged } from "./document-state";
import { areSamePath, resolveEditedActiveFilePath } from "./save-paths";

let sourceStateIntegrationInstalled = false;

export function getActiveDocumentFormat(): DocumentFormat {
    return getDocumentFormatById(documentState.activeFormatId);
}

export function installSourceStateDocumentIntegration(): void {
    if (sourceStateIntegrationInstalled) {
        return;
    }

    sourceStateIntegrationInstalled = true;
    const initialFormat = getActiveDocumentFormat();
    configureBlockIndexBuilder(initialFormat.index.build);
    configureProjectionCapability(initialFormat.projection);
    subscribeEditorState((next, previous, transaction) => {
        if (next.title !== previous.title) {
            readEditorDom().title.value = next.title;
            syncDocumentWindowTitle();
        }
        if (next.doc !== previous.doc) {
            syncDocumentProjectionFromState(next, previous, transaction);
        }
        if (next.doc !== previous.doc || next.title !== previous.title) {
            syncEditorDirtyState();
        }
    });
}

export function loadDocument(documentFile: DocumentFile): void {
    const format = getDocumentFormatForPath(documentFile.path || documentFile.name);
    const { title } = readEditorDom();
    const documentTitle = titleFromFileName(documentFile.name);

    documentState.activeFilePath = documentFile.path;
    documentState.activeFormatId = format.descriptor.id;
    documentState.usesTitle = false;
    syncDocumentFormatUi();
    syncBlockViewContext();
    title.value = documentTitle;
    configureBlockIndexBuilder(format.index.build);
    configureProjectionCapability(format.projection);
    replaceDocumentState(documentFile.content, documentTitle);
    const parsedBlocks = readParsedBlocksFromSourceState(getEditorState());
    loadDocumentRenderContext(format, parsedBlocks, format.render.readReferences?.(parsedBlocks) ?? {});
    syncDocumentProjectionFromState(getEditorState());
    syncDocumentReferences(format, documentState.activeFilePath);
    applyDocumentRenderContext(format);
    syncDocumentFooter(format);
    clearSourceHistory();
    documentState.lastSavedContent = getDocumentSource();
    documentState.hasUnsavedChanges = false;
    notifyDocumentStateChanged();
}

export function serializeDocument(): string {
    return getDocumentSource();
}

export function syncEditorDirtyState(): void {
    const state = getEditorState();
    const format = getActiveDocumentFormat();
    const editedPath = documentState.activeFilePath && format.descriptor.editableTitle
        ? resolveEditedActiveFilePath(
            documentState.activeFilePath,
            state.title,
            format.descriptor.defaultExtension,
        )
        : documentState.activeFilePath;
    const titleChanged = Boolean(
        documentState.activeFilePath && editedPath && !areSamePath(documentState.activeFilePath, editedPath),
    );
    documentState.hasUnsavedChanges = state.doc !== documentState.lastSavedContent || titleChanged;
    notifyDocumentStateChanged();
}

export function syncBlockViewContext(): void {
    syncRenderBlockViewContext(getActiveDocumentFormat(), documentState.activeFilePath);
}

export function syncDocumentFormatUi(): void {
    const { shell, surface, title } = readEditorDom();
    const format = getActiveDocumentFormat();

    title.hidden = !format.descriptor.editableTitle;
    surface.dataset.documentFormat = format.descriptor.id;
    shell.dataset.documentFormat = format.descriptor.id;

    syncDocumentPreview(format, {
        activeFilePath: documentState.activeFilePath,
        isSavingDocument: documentState.isSavingDocument,
    });
    syncDocumentFooter(format);
}

function syncDocumentProjectionFromState(
    state: ReturnType<typeof getEditorState>,
    previous?: ReturnType<typeof getEditorState>,
    transaction?: Parameters<Parameters<typeof subscribeEditorState>[0]>[2],
): void {
    const projectionStartedAt = readPerformanceNow();
    const format = getActiveDocumentFormat();
    const refreshRenderContext = shouldRefreshDocumentRenderContext(state, previous, transaction);
    const renderContextStartedAt = readPerformanceNow();
    const blocks = refreshRenderContext ? readParsedBlocksFromSourceState(state) : null;
    const renderContextChanged = blocks
        ? loadDocumentRenderContext(format, blocks, format.render.readReferences?.(blocks) ?? {})
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

function shouldRefreshDocumentRenderContext(
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
