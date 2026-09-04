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
import {
    clearSourceReveal,
    configureProjectionCapability,
    syncDomSelectionFromState,
    syncInlineTypingSourceReveal,
    syncStateSelectionFromDom,
} from "../editor/core/projection";
import { readEditorDom } from "../editor/editor-dom";
import { getDocumentFormatById, getDocumentFormatForPath } from "../formats/registry";
import { extensionFromPath, titleFromFileName } from "../formats/file-names";
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
    syncDocumentReferences,
} from "./document-render-context";
import { syncDocumentPreview } from "./document-preview";
import {
    beginDocumentSession,
    documentState,
    notifyDocumentStateChanged,
    type DocumentEditingMode,
} from "./document-state";
import { fileNameFromPath } from "../utils/text";

let sourceStateIntegrationInstalled = false;
let sourceViewFormat: DocumentFormat | null = null;

export function getActiveDocumentFormat(): DocumentFormat {
    return getDocumentFormatById(documentState.activeFormatId);
}

export function isMarkdownSourceMode(): boolean {
    return documentState.activeFormatId === "markdown" && documentState.editingMode === "source";
}

export function toggleMarkdownEditingMode(): void {
    const mode: DocumentEditingMode = isMarkdownSourceMode() ? "live-preview" : "source";
    if (documentState.activeFormatId !== "markdown" || documentState.editingMode === mode) {
        return;
    }

    syncStateSelectionFromDom();
    clearSourceReveal();
    const { editor, shell } = readEditorDom();
    const scrollTop = shell.scrollTop;
    const source = getDocumentSource();
    const selection = getEditorState().selection;

    documentState.editingMode = mode;
    const format = getActiveEditorFormat();
    configureBlockIndexBuilder(format.index.build);
    configureProjectionCapability(format.projection);
    replaceDocumentState(source, selection);
    const state = getEditorState();
    const blocks = readParsedBlocksFromSourceState(state);
    loadDocumentRenderContext(format, blocks, format.render.readReferences?.(blocks) ?? {});
    syncBlockViewContext();
    syncDocumentProjectionFromState(state);
    syncDocumentReferences(format, documentState.activeFilePath);
    applyDocumentRenderContext(format);
    syncDocumentFooter(format);
    syncDocumentFormatUi();
    notifyDocumentStateChanged();

    window.requestAnimationFrame(() => {
        shell.scrollTop = scrollTop;
        editor.focus({ preventScroll: true });
        syncDomSelectionFromState({ focus: "editor" });
    });
}

export function installSourceStateDocumentIntegration(): void {
    if (sourceStateIntegrationInstalled) {
        return;
    }

    sourceStateIntegrationInstalled = true;
    const initialFormat = getActiveEditorFormat();
    configureBlockIndexBuilder(initialFormat.index.build);
    configureProjectionCapability(initialFormat.projection);
    subscribeEditorState((next, previous, transaction) => {
        if (next.doc !== previous.doc) {
            invalidateMarkdownImageCache();
            syncDocumentProjectionFromState(next, previous, transaction);
            pruneUnreferencedPendingImages();
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
    sourceViewFormat = null;
    resetPendingImagesForSession();
    delete editor.dataset.virtualEofCaret;
    syncDocumentFormatUi();
    const editorFormat = getActiveEditorFormat();
    syncBlockViewContext();
    title.value = titleFromFileName(fileName);
    configureBlockIndexBuilder(editorFormat.index.build);
    configureProjectionCapability(editorFormat.projection);
    replaceDocumentState(decoded.source);
    const parsedBlocks = readParsedBlocksFromSourceState(getEditorState());
    loadDocumentRenderContext(editorFormat, parsedBlocks, editorFormat.render.readReferences?.(parsedBlocks) ?? {});
    syncDocumentProjectionFromState(getEditorState());
    syncDocumentReferences(editorFormat, documentState.activeFilePath);
    applyDocumentRenderContext(editorFormat);
    syncDocumentFooter(editorFormat);
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
        if (nextFormat.descriptor.id !== "markdown") {
            documentState.editingMode = "live-preview";
        }
        sourceViewFormat = null;
        const editorFormat = getActiveEditorFormat();
        configureBlockIndexBuilder(editorFormat.index.build);
        configureProjectionCapability(editorFormat.projection);
        syncDocumentFormatUi();
        syncBlockViewContext();
        replaceDocumentState(getDocumentSource(), getEditorState().selection);
        const blocks = readParsedBlocksFromSourceState(getEditorState());
        loadDocumentRenderContext(editorFormat, blocks, editorFormat.render.readReferences?.(blocks) ?? {});
        syncDocumentProjectionFromState(getEditorState());
        syncDocumentReferences(editorFormat, path);
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
    syncRenderBlockViewContext(getActiveEditorFormat(), documentState.activeFilePath);
}

export function syncDocumentFormatUi(): void {
    const { shell, surface, title, extension, markdownModeToggle } = readEditorDom();
    const format = getActiveDocumentFormat();

    title.hidden = false;
    title.readOnly = !format.descriptor.editableTitle;
    title.setAttribute("aria-readonly", String(title.readOnly));
    const activeExtension = extensionFromPath(documentState.fileName) || format.descriptor.defaultExtension;
    extension.textContent = `.${activeExtension}`;
    extension.setAttribute("aria-label", `${activeExtension} file extension`);
    surface.dataset.documentFormat = format.descriptor.id;
    shell.dataset.documentFormat = format.descriptor.id;
    surface.dataset.editingMode = documentState.editingMode;
    shell.dataset.editingMode = documentState.editingMode;
    const canToggleMarkdownMode = format.descriptor.id === "markdown";
    markdownModeToggle.hidden = !canToggleMarkdownMode;
    markdownModeToggle.textContent = isMarkdownSourceMode() ? "Source" : "Live Preview";
    markdownModeToggle.setAttribute("aria-pressed", String(isMarkdownSourceMode()));
    markdownModeToggle.title = isMarkdownSourceMode()
        ? "Switch to Markdown Live Preview"
        : "Switch to Markdown source mode";

    syncDocumentPreview(format, {
        activeFilePath: documentState.activeFilePath,
        isSavingDocument: documentState.isSavingDocument,
    });
    syncDocumentFooter(getActiveEditorFormat());
}

function syncDocumentProjectionFromState(
    state: ReturnType<typeof getEditorState>,
    previous?: ReturnType<typeof getEditorState>,
    transaction?: Parameters<Parameters<typeof subscribeEditorState>[0]>[2],
): void {
    const projectionStartedAt = readPerformanceNow();
    const format = getActiveEditorFormat();
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
    syncInlineTypingSourceReveal(state, transaction);
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

function getActiveEditorFormat(): DocumentFormat {
    const format = getActiveDocumentFormat();
    if (!isMarkdownSourceMode()) {
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
