import {
    configureBlockView,
    applyBlockProperties,
    createBlock,
    findBlock,
    getBlockText,
    getTodoCheckbox,
    getEditorBlocks,
    isRichTextBlockType,
    readEditorBlock,
    readBlockCodeFence,
    readBlockCodeFenceClosed,
    readBlockHeadingId,
    readBlockHeadingIdExplicit,
    readBlockIndent,
    readBlockListMarker,
    readBlockListNumber,
    readBlockListDelimiter,
    readBlockTodoMarker,
    readBlockQuoteLevel,
    readBlockRuleMarker,
    setBlockText,
} from "../editor/blocks/view";
import { updateCodeBlockBodyContent } from "../editor/blocks/rendering";
import { readBlockType, type ParsedBlock } from "../editor/blocks/model";
import { applySourceBlockProjectionMetadata } from "../editor/core/projection";
import type { EditorState, SourceBlock } from "../editor/core/types";
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

export function loadDocumentRenderContext(
    format: DocumentFormat,
    blocks: ParsedBlock[],
    fallbackReferences: DocumentReferenceMap,
): boolean {
    const nextContext = readFormatRenderContext(format, blocks, fallbackReferences);
    const nextSnapshot = JSON.stringify(nextContext);
    if (nextSnapshot === documentReferencesSnapshot) {
        return false;
    }

    documentRenderContext = nextContext;
    documentReferences = documentRenderContext.references;
    documentReferencesSnapshot = nextSnapshot;
    return true;
}

export function syncDocumentReferences(activeFormat: DocumentFormat, activeFilePath: string | null): void {
    const blocks = getEditorBlocks().map(readEditorBlock);
    const nextContext = readFormatRenderContext(activeFormat, blocks, activeFormat.render.readReferences?.(blocks) ?? {});
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
    format.render.applyRenderContext?.(getEditorBlocks(), documentRenderContext);
}

export function syncDocumentFooter(format: DocumentFormat): void {
    const { footer } = readEditorDom();
    const html = format.render.renderDocumentFooter?.(documentRenderContext) ?? "";
    footer.hidden = html === "";
    footer.innerHTML = html;
}

export function replaceEditorBlocksFromSourceState(state: EditorState, previous?: EditorState): void {
    const { editor } = readEditorDom();
    const currentBlocks = getEditorBlocks();
    const currentById = new Map(currentBlocks.map((block) => [block.dataset.blockId, block]));
    const previousById = new Map(previous?.blocks.blocks.map((block) => [block.id, block]) ?? []);
    const nextBlocks = state.blocks.blocks.map((sourceBlock) => {
        const block = readParsedBlockFromSourceState(state, sourceBlock);
        const current = currentById.get(sourceBlock.id);
        const previousBlock = previousById.get(sourceBlock.id);
        const sourceChanged = !previous || !previousBlock || !sourceBlocksEquivalent(state, sourceBlock, previous, previousBlock);
        const element = current && readBlockType(current.dataset.type) === block.type
            ? sourceChanged && projectedBlockNeedsUpdate(current, block) ? updateProjectedBlock(current, block) : current
            : createBlock(block.type, block.text, block);
        // IDs are intentionally reused across reparses, including for visually
        // identical empty blocks. Their absolute source ranges can still move,
        // so projection metadata must never be treated as render-cache data.
        applySourceBlockProjectionMetadata(element, sourceBlock, state.doc);
        return element;
    });

    reconcileEditorBlocks(editor, currentBlocks, nextBlocks);
}

function sourceBlocksEquivalent(
    state: EditorState,
    block: SourceBlock,
    previous: EditorState,
    previousBlock: SourceBlock,
): boolean {
    return (
        block.type === previousBlock.type &&
        state.doc.slice(block.contentFrom, block.contentTo) === previous.doc.slice(previousBlock.contentFrom, previousBlock.contentTo) &&
        block.indent === previousBlock.indent &&
        block.checked === previousBlock.checked &&
        block.codeFence === previousBlock.codeFence &&
        block.codeFenceClosed === previousBlock.codeFenceClosed &&
        block.codeInfo === previousBlock.codeInfo &&
        block.listMarker === previousBlock.listMarker &&
        block.listNumber === previousBlock.listNumber &&
        block.listDelimiter === previousBlock.listDelimiter &&
        block.todoMarker === previousBlock.todoMarker &&
        block.quoteLevel === previousBlock.quoteLevel &&
        block.ruleMarker === previousBlock.ruleMarker &&
        block.mathSource === previousBlock.mathSource &&
        block.headingId === previousBlock.headingId &&
        block.headingIdExplicit === previousBlock.headingIdExplicit
    );
}

function projectedBlockNeedsUpdate(element: HTMLElement, block: ParsedBlock): boolean {
    const type = readBlockType(element.dataset.type);
    return (
        getBlockText(element) !== block.text ||
        readBlockIndent(element) !== (block.indent ?? 0) ||
        readBlockListMarker(element) !== block.listMarker ||
        readBlockListNumber(element) !== block.listNumber ||
        readBlockListDelimiter(element) !== block.listDelimiter ||
        readBlockTodoMarker(element) !== block.todoMarker ||
        readBlockQuoteLevel(element) !== block.quoteLevel ||
        readBlockCodeFence(element) !== block.codeFence ||
        readBlockCodeFenceClosed(element) !== block.codeFenceClosed ||
        (element.dataset.codeInfo ?? "") !== (block.codeInfo ?? "") ||
        readBlockRuleMarker(element) !== block.ruleMarker ||
        (type === "todo" && getTodoCheckbox(element).checked !== Boolean(block.checked)) ||
        (type === "math" && element.dataset.mathSource !== block.mathSource) ||
        readBlockHeadingId(element) !== block.headingId ||
        readBlockHeadingIdExplicit(element) !== Boolean(block.headingIdExplicit)
    );
}

function updateProjectedBlock(element: HTMLElement, block: ParsedBlock): HTMLElement {
    const canUpdateCodeContent = block.type === "code" && codeSourceStructureMatches(element, block);
    applyBlockProperties(element, block);
    const content = element.querySelector<HTMLElement>(".block-content");
    if (canUpdateCodeContent && content && updateCodeBlockBodyContent(content, block.text)) {
        return element;
    }

    // Block markers, suffixes, and preview source are derived from properties
    // as well as body text. Re-render even when the visible body is unchanged.
    setBlockText(element, block.text);
    return element;
}

function codeSourceStructureMatches(element: HTMLElement, block: ParsedBlock): boolean {
    return readBlockCodeFenceClosed(element) === block.codeFenceClosed;
}

function reconcileEditorBlocks(editor: HTMLElement, currentBlocks: HTMLElement[], nextBlocks: HTMLElement[]): void {
    const nextSet = new Set(nextBlocks);
    for (const block of currentBlocks) {
        if (!nextSet.has(block)) {
            block.remove();
        }
    }

    for (let index = 0; index < nextBlocks.length; index += 1) {
        const next = nextBlocks[index];
        const currentAtIndex = editor.children[index];
        if (currentAtIndex !== next) {
            editor.insertBefore(next, currentAtIndex ?? null);
        }
    }
}

export function readParsedBlocksFromSourceState(state: EditorState): ParsedBlock[] {
    return state.blocks.blocks.map((block) => readParsedBlockFromSourceState(state, block));
}

function createBlockViewContext(format: DocumentFormat, activeFilePath: string | null): void {
    configureBlockView({
        context: documentRenderContext,
        references: documentReferences,
        activeFilePath,
        renderInlineContent: format.render.renderInline,
        renderPlainTextContent: format.render.renderPlainTextContent,
        renderBlockContent: format.render.renderBlock,
        hydrateRenderedContent: format.render.hydrateRenderedContent,
        readBlockSource: format.render.readBlockSource,
        readInteractiveBlockText: format.render.readInteractiveBlockText,
        plainTextHighlightPolicy: format.render.plainTextHighlightPolicy,
    });
}

function readFormatRenderContext(
    format: DocumentFormat,
    blocks: ParsedBlock[],
    fallbackReferences: DocumentReferenceMap,
): DocumentRenderContext {
    return format.render.readRenderContext?.(blocks) ?? { references: fallbackReferences };
}

function readParsedBlockFromSourceState(state: EditorState, block: SourceBlock): ParsedBlock {
    return {
        type: block.type,
        text: state.doc.slice(block.contentFrom, block.contentTo),
        indent: block.indent,
        checked: block.checked,
        codeFence: block.codeFence,
        codeFenceClosed: block.codeFenceClosed,
        codeInfo: block.codeInfo,
        listMarker: block.listMarker,
        listNumber: block.listNumber,
        listDelimiter: block.listDelimiter,
        todoMarker: block.todoMarker,
        quoteLevel: block.quoteLevel,
        ruleMarker: block.ruleMarker,
        mathSource: block.mathSource,
        headingId: block.headingId,
        headingIdExplicit: block.headingIdExplicit,
    };
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
