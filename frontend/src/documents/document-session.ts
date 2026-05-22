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
        renderBlockContent: format.renderBlock,
        hydrateRenderedContent: format.hydrateRenderedContent,
        readBlockSource: format.readBlockSource,
    });
}

export function syncDocumentFormatUi(): void {
    const title = getElement<HTMLInputElement>("document-title");
    const surface = getElement<HTMLElement>("document-surface");
    const format = getActiveDocumentFormat();

    title.hidden = !format.supportsTitle;
    surface.dataset.documentFormat = format.id;
}

function syncDocumentReferences(): void {
    const nextReferences = getActiveDocumentFormat().readReferences?.(getEditorBlocks().map(readEditorBlock)) ?? {};
    if (JSON.stringify(nextReferences) === JSON.stringify(documentReferences)) {
        return;
    }

    documentReferences = nextReferences;
    syncBlockViewContext();
    rerenderInlineContentBlocks();
}

function rerenderInlineContentBlocks(): void {
    const selection = document.getSelection();
    const activeBlock = findBlock(selection?.focusNode ?? null);
    const activeOffset = activeBlock ? getCurrentBlockOffset(activeBlock) : null;

    for (const block of getEditorBlocks()) {
        if (isRichTextBlockType(readBlockType(block.dataset.type))) {
            setBlockText(block, getBlockText(block));
        }
    }

    if (activeBlock?.isConnected && activeOffset !== null) {
        focusBlockAtOffset(activeBlock, Math.min(activeOffset, getBlockText(activeBlock).length));
    }
}

function replaceEditorBlocks(blocks: ParsedBlock[]): void {
    const editor = getElement<HTMLElement>("editor");
    const nextBlocks = blocks.map((block) => createBlock(block.type, block.text, block));

    editor.replaceChildren(...nextBlocks);
    syncFirstBlockPlaceholder();
    focusBlockAtOffset(nextBlocks[0], 0);
}
