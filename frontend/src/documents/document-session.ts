import type { DocumentFile } from "../bridge/types";
import { cancelPendingEdit, flushPendingEdit, hasDirtyPendingEdit } from "../editor/core/pending-edit";
import {
    clearSourceHistory,
    configureBlockIndexBuilder,
    getEditorState,
    getDocumentRevision,
    getDocumentSource,
    measureEditorPerformance,
    readPerformanceNow,
    replaceDocumentState,
    subscribeEditorState,
} from "../editor/core/store";
import {
    clearSourceReveal,
    configureProjectionCapability,
    syncDomSelectionFromState,
    syncInlineTypingSourceReveal,
    syncStateSelectionFromDom,
} from "../editor/core/projection";
import { readEditorDom } from "../editor/editor-dom";
import { getDocumentFormatById, getDocumentFormatForPath } from "../formats/registry";
import type { DocumentFormat } from "../formats/types";
import { createSourceViewDocumentFormat } from "../formats/source/document";
import { pruneUnreferencedPendingImages, resetPendingImagesForSession } from "../formats/markdown/pending-images";
import { invalidateMarkdownImageCache } from "../formats/markdown/images";
import {
    applyDocumentRenderContext,
    loadDocumentRenderContext,
    readParsedBlocksFromSourceState,
    replaceEditorBlocksFromSourceState,
    syncBlockViewContext as syncRenderBlockViewContext,
    syncDocumentFooter,
} from "./document-render-context";
import {
    beginDocumentSession,
    commitSavedFileName,
    documentState,
    notifyDocumentStateChanged,
    recordSavedDocumentContent,
    type DocumentEditingMode,
} from "./document-state";
import { fileNameFromPath } from "../utils/text";

let sourceStateIntegrationInstalled = false;
let sourceViewFormat: DocumentFormat | null = null;
let initializingEditor = false;

export function getActiveDocumentFormat(): DocumentFormat {
    return getDocumentFormatById(documentState.activeFormatId);
}

export function isSourceEditingMode(): boolean {
    return documentState.editingMode === "source";
}

export function toggleDocumentEditingMode(): void {
    const mode: DocumentEditingMode = isSourceEditingMode() ? "live-preview" : "source";
    if (!getActiveDocumentFormat().livePreview || documentState.editingMode === mode) {
        return;
    }

    flushPendingEdit();
    syncStateSelectionFromDom();
    clearSourceReveal();
    const { editor, shell } = readEditorDom();
    const scrollTop = shell.scrollTop;
    const source = getDocumentSource();
    const selection = getEditorState().selection;

    const modeStartedAt = readPerformanceNow();
    documentState.editingMode = mode;
    initializeDocumentEditor(source, selection);
    measureAfterPaintOpportunity("glyph:mode-switch-to-paint", modeStartedAt);
    notifyDocumentStateChanged();

    const session = documentState.sessionId;
    window.requestAnimationFrame(() => {
        if (session !== documentState.sessionId || documentState.editingMode !== mode) return;
        shell.scrollTop = scrollTop;
        editor.focus({ preventScroll: true });
        syncDomSelectionFromState({ focus: "editor" });
    });
}

export function installSourceStateDocumentIntegration(onContentChanged: () => void): void {
    if (sourceStateIntegrationInstalled) {
        return;
    }

    sourceStateIntegrationInstalled = true;
    const initialFormat = getActiveEditorFormat();
    configureBlockIndexBuilder(initialFormat.index.build);
    configureProjectionCapability(initialFormat.projection);
    subscribeEditorState((next, previous, transaction) => {
        if (!initializingEditor && next.doc !== previous.doc) {
            syncDocumentProjectionFromState(next, previous, transaction);
            pruneUnreferencedPendingImages();
            onContentChanged();
            syncEditorDirtyState();
        }
    });
}

export function loadDocument(documentFile: DocumentFile): void {
    const loadStartedAt = readPerformanceNow();
    cancelPendingEdit();
    const format = getDocumentFormatForPath(documentFile.path || documentFile.name);
    const { editor } = readEditorDom();
    const fileName = documentFile.name || format.descriptor.defaultFileName;
    const decoded = decodeDocumentSource(documentFile.content);

    beginDocumentSession({
        path: documentFile.path || null,
        formatId: format.descriptor.id,
        fileName,
        lineEnding: decoded.lineEnding,
        hasUtf8Bom: decoded.hasUtf8Bom,
        editingMode: format.livePreview ? "live-preview" : "source",
    });
    sourceViewFormat = null;
    resetPendingImagesForSession();
    invalidateMarkdownImageCache();
    delete editor.dataset.virtualEofCaret;
    initializeDocumentEditor(decoded.source);
    clearSourceHistory();
    recordSavedDocumentContent(serializeDocument());
    documentState.hasUnsavedChanges = false;
    notifyDocumentStateChanged();
    measureAfterPaintOpportunity("glyph:load-to-paint", loadStartedAt);
}

export function serializeDocument(): string {
    const source = documentState.lineEnding === "\r\n"
        ? getDocumentSource().replace(/\n/g, "\r\n")
        : getDocumentSource();
    return documentState.hasUtf8Bom ? `\uFEFF${source}` : source;
}

export function commitSavedDocument(path: string, savedContent: string, fileNameAtSave?: string): void {
    const nextFormat = getDocumentFormatForPath(path);
    const formatChanged = nextFormat.descriptor.id !== documentState.activeFormatId;
    documentState.activeFilePath = path;
    documentState.activeFormatId = nextFormat.descriptor.id;
    commitSavedFileName(fileNameFromPath(path), fileNameAtSave);
    recordSavedDocumentContent(savedContent);

    if (formatChanged) {
        if (!nextFormat.livePreview) {
            documentState.editingMode = "source";
        }
        sourceViewFormat = null;
        initializeDocumentEditor(getDocumentSource(), getEditorState().selection);
    } else {
        const format = getActiveEditorFormat();
        syncRenderBlockViewContext(format, documentState.activeFilePath);
        syncDocumentFooter(format);
    }

    syncEditorDirtyState();
}

export function syncEditorDirtyState(): void {
    documentState.hasUnsavedChanges =
        getDocumentSource() !== documentState.lastSavedSource ||
        documentState.fileNameDirty || hasDirtyPendingEdit();
    notifyDocumentStateChanged();
}

function initializeDocumentEditor(source: string, selection?: ReturnType<typeof getEditorState>["selection"]): void {
    const format = getActiveEditorFormat();
    configureBlockIndexBuilder(format.index.build);
    configureProjectionCapability(format.projection);
    // Replacement still dispatches to store consumers. This session owns its
    // projection explicitly, including identical-source format/mode changes.
    initializingEditor = true;
    try {
        replaceDocumentState(source, selection);
    } finally {
        initializingEditor = false;
    }
    syncDocumentProjectionFromState(getEditorState());
}

function syncDocumentProjectionFromState(
    state: ReturnType<typeof getEditorState>,
    previous?: ReturnType<typeof getEditorState>,
    transaction?: Parameters<Parameters<typeof subscribeEditorState>[0]>[2],
): void {
    const projectionStartedAt = readPerformanceNow();
    const format = getActiveEditorFormat();
    const refreshRenderContext = !previous || !transaction ||
        (format.render.shouldRefreshRenderContext?.(state, previous, transaction) ?? Boolean(format.render.readRenderContext));
    const renderContextStartedAt = readPerformanceNow();
    const blocks = refreshRenderContext ? readParsedBlocksFromSourceState(state) : null;
    const renderContextChanged = blocks
        ? loadDocumentRenderContext(format, blocks)
        : false;
    measureEditorPerformance("glyph:render-context", renderContextStartedAt);
    if (renderContextChanged || !previous) {
        syncRenderBlockViewContext(format, documentState.activeFilePath);
    }
    replaceEditorBlocksFromSourceState(state, previous, renderContextChanged);
    syncInlineTypingSourceReveal(state, transaction);
    if (renderContextChanged || !previous) {
        applyDocumentRenderContext(format);
        syncDocumentFooter(format);
    }
    const selectionStartedAt = readPerformanceNow();
    const userEdit = transaction?.annotations?.userEvent;
    const editor = readEditorDom().editor;
    syncDomSelectionFromState({
        focus: "preserve",
        scrollIntoView: Boolean(userEdit && userEdit !== "programmatic" && editor.contains(document.activeElement)),
    });
    measureEditorPerformance("glyph:selection-restoration", selectionStartedAt);
    measureEditorPerformance("glyph:projection", projectionStartedAt);
}

function getActiveEditorFormat(): DocumentFormat {
    const format = getActiveDocumentFormat();
    if (!isSourceEditingMode() || !format.livePreview) {
        return format;
    }

    if (!sourceViewFormat || sourceViewFormat.descriptor.id !== format.descriptor.id) {
        sourceViewFormat = createSourceViewDocumentFormat(format);
    }
    return sourceViewFormat;
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

/** Two frames bracket a paint opportunity, not a native input-to-paint trace. */
function measureAfterPaintOpportunity(name: string, startedAt: number): void {
    if (!import.meta.env?.DEV) return;
    const session = documentState.sessionId;
    const revision = getDocumentRevision();
    const mode = documentState.editingMode;
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        if (session !== documentState.sessionId || revision !== getDocumentRevision() || mode !== documentState.editingMode) return;
        measureEditorPerformance(name, startedAt);
    }));
}
