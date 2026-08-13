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
import { resetPendingImagesForSession } from "../formats/markdown/pending-images";
import { invalidateMarkdownImageCache } from "../formats/markdown/images";
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
import { beginDocumentSession, documentState, notifyDocumentStateChanged } from "./document-state";
import { fileNameFromPath } from "../utils/text";

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
        if (next.doc !== previous.doc) {
            invalidateMarkdownImageCache();
            syncDocumentProjectionFromState(next, previous, transaction);
            syncEditorDirtyState();
        }
    });
}

export function loadDocument(documentFile: DocumentFile): void {
    const format = getDocumentFormatForPath(documentFile.path || documentFile.name);
    const { editor, title } = readEditorDom();
    const fileName = documentFile.name || format.descriptor.defaultFileName;
    const decoded = decodeDocumentSource(documentFile.content);

    beginDocumentSession({
        path: documentFile.path || null,
        formatId: format.descriptor.id,
        fileName,
        lineEnding: decoded.lineEnding,
        hasUtf8Bom: decoded.hasUtf8Bom,
    });
    resetPendingImagesForSession();
    delete editor.dataset.virtualEofCaret;
    syncDocumentFormatUi();
    syncBlockViewContext();
    title.value = titleFromFileName(fileName);
    configureBlockIndexBuilder(format.index.build);
    configureProjectionCapability(format.projection);
    replaceDocumentState(decoded.source);
    const parsedBlocks = readParsedBlocksFromSourceState(getEditorState());
    loadDocumentRenderContext(format, parsedBlocks, format.render.readReferences?.(parsedBlocks) ?? {});
    syncDocumentProjectionFromState(getEditorState());
    syncDocumentReferences(format, documentState.activeFilePath);
    applyDocumentRenderContext(format);
    syncDocumentFooter(format);
    clearSourceHistory();
    documentState.lastSavedContent = serializeDocument();
    documentState.hasUnsavedChanges = false;
    notifyDocumentStateChanged();
    syncDocumentWindowTitle();
}

export function serializeDocument(): string {
    const source = documentState.lineEnding === "\r\n"
        ? getDocumentSource().replace(/\n/g, "\r\n")
        : getDocumentSource();
    return documentState.hasUtf8Bom ? `\uFEFF${source}` : source;
}

export function commitSavedDocument(path: string, savedContent: string): void {
    const nextFormat = getDocumentFormatForPath(path);
    const formatChanged = nextFormat.descriptor.id !== documentState.activeFormatId;
    documentState.activeFilePath = path;
    documentState.activeFormatId = nextFormat.descriptor.id;
    documentState.fileName = fileNameFromPath(path);
    documentState.committedFileName = documentState.fileName;
    documentState.fileNameDirty = false;
    documentState.lastSavedContent = savedContent;
    readEditorDom().title.value = titleFromFileName(documentState.fileName);

    if (formatChanged) {
        configureBlockIndexBuilder(nextFormat.index.build);
        configureProjectionCapability(nextFormat.projection);
        syncDocumentFormatUi();
        syncBlockViewContext();
        replaceDocumentState(getDocumentSource(), getEditorState().selection);
        const blocks = readParsedBlocksFromSourceState(getEditorState());
        loadDocumentRenderContext(nextFormat, blocks, nextFormat.render.readReferences?.(blocks) ?? {});
        syncDocumentProjectionFromState(getEditorState());
        syncDocumentReferences(nextFormat, path);
    } else {
        syncBlockViewContext();
    }

    syncEditorDirtyState();
    syncDocumentWindowTitle();
}

export function syncEditorDirtyState(): void {
    documentState.hasUnsavedChanges =
        serializeDocument() !== documentState.lastSavedContent ||
        documentState.fileNameDirty;
    notifyDocumentStateChanged();
    syncDocumentWindowTitle();
}

export function syncBlockViewContext(): void {
    syncRenderBlockViewContext(getActiveDocumentFormat(), documentState.activeFilePath);
}

export function syncDocumentFormatUi(): void {
    const { shell, surface, title } = readEditorDom();
    const format = getActiveDocumentFormat();

    title.hidden = false;
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
    syncDomSelectionFromState({ focus: "preserve" });
    measureEditorPerformance("glyph:selection-restoration", selectionStartedAt);
    measureEditorPerformance("glyph:projection", projectionStartedAt);
}

function decodeDocumentSource(content: string): {
    source: string;
    lineEnding: "\n" | "\r\n";
    hasUtf8Bom: boolean;
} {
    const hasUtf8Bom = content.startsWith("\uFEFF");
    const withoutBom = hasUtf8Bom ? content.slice(1) : content;
    const lineEnding = withoutBom.includes("\r\n") && !/(^|[^\r])\n/.test(withoutBom)
        ? "\r\n"
        : "\n";
    return {
        source: withoutBom.replace(/\r\n?/g, "\n"),
        lineEnding,
        hasUtf8Bom,
    };
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
