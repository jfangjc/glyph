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
import { getDocumentFormatById, getDocumentFormatForPath } from "../formats/registry";
import type { DocumentFormat, DocumentPreviewBehavior, DocumentPreviewContext, DocumentReferenceMap, DocumentRenderContext } from "../formats/types";
import { documentState, markDocumentDirty, notifyDocumentStateChanged } from "./document-state";

let documentReferences: DocumentReferenceMap = {};
let documentRenderContext: DocumentRenderContext = { references: documentReferences };
let documentReferencesSnapshot = "{}";
let referenceRerenderRequestId = 0;
let referenceSyncFrame = 0;
let activePreviewBehavior: DocumentPreviewBehavior | null = null;

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
    documentRenderContext = readFormatRenderContext(format, parsedDocument.blocks, parsedDocument.references ?? {});
    documentReferences = documentRenderContext.references;
    documentReferencesSnapshot = JSON.stringify(documentRenderContext);
    syncDocumentFormatUi();
    syncBlockViewContext();
    title.value = parsedDocument.title;
    replaceEditorBlocks(parsedDocument.blocks);
    syncDocumentReferences();
    applyDocumentRenderContext();
    syncDocumentFooter();
    clearEditorHistory();
    documentState.lastSavedContent = serializeDocument();
    documentState.hasUnsavedChanges = false;
    notifyDocumentStateChanged();
}

export function serializeDocument(): string {
    getActiveDocumentFormat().editorBehavior?.beforeSerialize?.();
    if (!flushDocumentReferenceSync()) {
        syncDocumentReferences();
    }
    const title = getElement<HTMLInputElement>("document-title").value;
    const format = getActiveDocumentFormat();

    return format.serializeDocument(
        format.supportsTitle ? title : "",
        format.supportsTitle && documentState.usesTitle,
        getSerializableEditorBlocks().map(readEditorBlock),
    );
}

export function markEditorDirty(): void {
    scheduleDocumentReferenceSync();
    markDocumentDirty();
}

export function syncEditorDirtyState(): void {
    documentState.hasUnsavedChanges = serializeDocument() !== documentState.lastSavedContent;
    notifyDocumentStateChanged();
}

export function syncBlockViewContext(): void {
    const format = getActiveDocumentFormat();

    configureBlockView({
        context: documentRenderContext,
        references: documentReferences,
        activeFilePath: documentState.activeFilePath,
        renderInlineContent: format.renderInline,
        renderPlainTextContent: format.renderPlainTextContent,
        renderBlockContent: format.renderBlock,
        hydrateRenderedContent: format.hydrateRenderedContent,
        readBlockSource: format.readBlockSource,
        plainTextHighlightPolicy: format.plainTextHighlightPolicy,
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

    syncDocumentPreview(format);
    syncDocumentFooter();
}

function syncDocumentPreview(format: DocumentFormat): void {
    const context = createDocumentPreviewContext();

    if (activePreviewBehavior && activePreviewBehavior !== format.previewBehavior) {
        activePreviewBehavior.deactivate(context);
    }

    activePreviewBehavior = format.previewBehavior ?? null;
    activePreviewBehavior?.sync(context);
}

function createDocumentPreviewContext(): DocumentPreviewContext {
    return {
        activeFilePath: documentState.activeFilePath,
        isSavingDocument: documentState.isSavingDocument,
    };
}

function scheduleDocumentReferenceSync(): void {
    if (referenceSyncFrame) {
        return;
    }

    referenceSyncFrame = window.requestAnimationFrame(() => {
        referenceSyncFrame = 0;
        syncDocumentReferences();
    });
}

function flushDocumentReferenceSync(): boolean {
    if (referenceSyncFrame) {
        window.cancelAnimationFrame(referenceSyncFrame);
        referenceSyncFrame = 0;
        syncDocumentReferences();
        return true;
    }

    return false;
}

function syncDocumentReferences(): void {
    const format = getActiveDocumentFormat();
    const blocks = getEditorBlocks().map(readEditorBlock);
    const nextContext = readFormatRenderContext(format, blocks, format.readReferences?.(blocks) ?? {});
    const nextReferencesSnapshot = JSON.stringify(nextContext);
    if (nextReferencesSnapshot === documentReferencesSnapshot) {
        applyDocumentRenderContext();
        syncDocumentFooter();
        return;
    }

    documentRenderContext = nextContext;
    documentReferences = nextContext.references;
    documentReferencesSnapshot = nextReferencesSnapshot;
    syncBlockViewContext();
    applyDocumentRenderContext();
    syncDocumentFooter();
    rerenderInlineContentBlocks();
}

function readFormatRenderContext(
    format: DocumentFormat,
    blocks: ParsedBlock[],
    fallbackReferences: DocumentReferenceMap,
): DocumentRenderContext {
    return format.readRenderContext?.(blocks) ?? { references: fallbackReferences };
}

function applyDocumentRenderContext(): void {
    getActiveDocumentFormat().applyRenderContext?.(getEditorBlocks(), documentRenderContext);
}

function syncDocumentFooter(): void {
    const footer = getElement<HTMLElement>("document-render-footer");
    const html = getActiveDocumentFormat().renderDocumentFooter?.(documentRenderContext) ?? "";
    footer.hidden = html === "";
    footer.innerHTML = html;
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
