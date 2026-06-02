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
import { readEditorDom } from "../editor/editor-dom";
import type {
    DocumentFormat,
    DocumentReferenceMap,
    DocumentRenderContext,
} from "../formats/types";

let documentReferences: DocumentReferenceMap = {};
let documentRenderContext: DocumentRenderContext = { references: documentReferences };
let documentReferencesSnapshot = "{}";
let referenceRerenderRequestId = 0;
let referenceSyncFrame = 0;

export function loadDocumentRenderContext(
    format: DocumentFormat,
    blocks: ParsedBlock[],
    fallbackReferences: DocumentReferenceMap,
): void {
    documentRenderContext = readFormatRenderContext(format, blocks, fallbackReferences);
    documentReferences = documentRenderContext.references;
    documentReferencesSnapshot = JSON.stringify(documentRenderContext);
}

export function serializeDocumentBlocks(format: DocumentFormat, activeFilePath: string | null): ParsedBlock[] {
    format.editorBehavior?.beforeSerialize?.();
    if (!flushDocumentReferenceSync(format, activeFilePath)) {
        syncDocumentReferences(format, activeFilePath);
    }

    return getSerializableEditorBlocks().map(readEditorBlock);
}

export function scheduleDocumentReferenceSync(
    getFormat: () => DocumentFormat,
    getActiveFilePath: () => string | null,
): void {
    if (referenceSyncFrame) {
        return;
    }

    referenceSyncFrame = window.requestAnimationFrame(() => {
        referenceSyncFrame = 0;
        syncDocumentReferences(getFormat(), getActiveFilePath());
    });
}

export function flushDocumentReferenceSync(format: DocumentFormat, activeFilePath: string | null): boolean {
    if (referenceSyncFrame) {
        window.cancelAnimationFrame(referenceSyncFrame);
        referenceSyncFrame = 0;
        syncDocumentReferences(format, activeFilePath);
        return true;
    }

    return false;
}

export function syncDocumentReferences(activeFormat: DocumentFormat, activeFilePath: string | null): void {
    const blocks = getEditorBlocks().map(readEditorBlock);
    const nextContext = readFormatRenderContext(activeFormat, blocks, activeFormat.readReferences?.(blocks) ?? {});
    const nextReferencesSnapshot = JSON.stringify(nextContext);
    if (nextReferencesSnapshot === documentReferencesSnapshot) {
        applyDocumentRenderContext(activeFormat);
        syncDocumentFooter(activeFormat);
        return;
    }

    documentRenderContext = nextContext;
    documentReferences = nextContext.references;
    documentReferencesSnapshot = nextReferencesSnapshot;
    syncBlockViewContext(activeFormat, activeFilePath);
    applyDocumentRenderContext(activeFormat);
    syncDocumentFooter(activeFormat);
    rerenderInlineContentBlocks();
}

export function syncBlockViewContext(format: DocumentFormat, activeFilePath: string | null = null): void {
    createBlockViewContext(format, activeFilePath);
}

export function applyDocumentRenderContext(format: DocumentFormat): void {
    format.applyRenderContext?.(getEditorBlocks(), documentRenderContext);
}

export function syncDocumentFooter(format: DocumentFormat): void {
    const { footer } = readEditorDom();
    const html = format.renderDocumentFooter?.(documentRenderContext) ?? "";
    footer.hidden = html === "";
    footer.innerHTML = html;
}

export function replaceEditorBlocks(blocks: ParsedBlock[]): void {
    const { editor } = readEditorDom();
    const nextBlocks = blocks.map((block) => createBlock(block.type, block.text, block));

    editor.replaceChildren(...nextBlocks);
    syncFirstBlockPlaceholder();
    focusBlockAtOffset(nextBlocks[0], 0);
}

function createBlockViewContext(format: DocumentFormat, activeFilePath: string | null): void {
    configureBlockView({
        context: documentRenderContext,
        references: documentReferences,
        activeFilePath,
        renderInlineContent: format.renderInline,
        renderPlainTextContent: format.renderPlainTextContent,
        renderBlockContent: format.renderBlock,
        hydrateRenderedContent: format.hydrateRenderedContent,
        readBlockSource: format.readBlockSource,
        plainTextHighlightPolicy: format.plainTextHighlightPolicy,
    });
}

function readFormatRenderContext(
    format: DocumentFormat,
    blocks: ParsedBlock[],
    fallbackReferences: DocumentReferenceMap,
): DocumentRenderContext {
    return format.readRenderContext?.(blocks) ?? { references: fallbackReferences };
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
