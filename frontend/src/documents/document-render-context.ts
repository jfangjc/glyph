import {
    configureBlockView,
    applyBlockProperties,
    createBlock,
    getEditorBlocks,
    readBlockCodeFenceClosed,
    setBlockText,
} from "../editor/blocks/view";
import { updateCodeBlockBodyContent } from "../editor/blocks/rendering";
import { readBlockType, type ParsedBlock } from "../editor/blocks/model";
import { applySourceBlockProjectionMetadata, registerProjectedBlocks } from "../editor/core/projection";
import type { EditorState, SourceBlock } from "../editor/core/types";
import { readEditorDom } from "../editor/editor-dom";
import type {
    DocumentFormat,
    DocumentRenderContext,
} from "../formats/types";
import { createRenderContextCache } from "../formats/render-context-cache";

// Source properties share strict equality; DOM properties below have distinct defaults.
const renderBlockPropertyKeys = [
    "indent",
    "checked",
    "codeFence",
    "codeFenceClosed",
    "codeInfo",
    "listMarker",
    "listNumber",
    "listDelimiter",
    "todoMarker",
    "quoteLevel",
    "continuationPrefix",
    "ruleMarker",
    "mathSource",
    "headingId",
    "headingIdExplicit",
    "headingSourcePrefix",
    "headingSourceSuffix",
] as const satisfies readonly (keyof ParsedBlock)[];

let documentRenderContext: DocumentRenderContext = { references: {} };
const renderContextCache = createRenderContextCache();
let footerHtml: string | undefined;

export function loadDocumentRenderContext(
    format: DocumentFormat,
    blocks: ParsedBlock[],
): boolean {
    const changed = renderContextCache.update(format.render, blocks);
    documentRenderContext = renderContextCache.current;
    return changed;
}

export function syncBlockViewContext(format: DocumentFormat, activeFilePath: string | null = null): void {
    configureBlockView({
        context: documentRenderContext,
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

export function applyDocumentRenderContext(format: DocumentFormat): void {
    format.render.applyRenderContext?.(getEditorBlocks(), documentRenderContext);
}

export function syncDocumentFooter(format: DocumentFormat): void {
    const { footer } = readEditorDom();
    const html = format.render.renderDocumentFooter?.(documentRenderContext) ?? "";
    if (footer.hidden !== (html === "")) footer.hidden = html === "";
    if (footerHtml !== html) {
        footer.innerHTML = html;
        footerHtml = html;
    }
}

export function replaceEditorBlocksFromSourceState(state: EditorState, previous?: EditorState, renderContextChanged = false): void {
    const { editor } = readEditorDom();
    const currentBlocks = getEditorBlocks();
    const currentById = new Map(currentBlocks.map((block) => [block.dataset.blockId, block]));
    const previousById = new Map(previous?.blocks.blocks.map((block) => [block.id, block]) ?? []);
    const nextBlocks = state.blocks.blocks.map((sourceBlock) => {
        const current = previous ? currentById.get(sourceBlock.id) : undefined;
        const previousBlock = previousById.get(sourceBlock.id);
        const sourceChanged = !previous || !previousBlock || !sourceBlocksEquivalent(state, sourceBlock, previous, previousBlock);
        let element = current;
        if (!element || readBlockType(element.dataset.type) !== sourceBlock.type) {
            const block = readParsedBlockFromSourceState(state, sourceBlock);
            element = createBlock(block.type, block.text, block);
        } else if (sourceChanged || renderContextChanged) {
            const block = readParsedBlockFromSourceState(state, sourceBlock);
            element = updateProjectedBlock(element, block);
        }
        // IDs are intentionally reused across reparses, including for visually
        // identical empty blocks. Their absolute source ranges can still move,
        // so projection metadata must never be treated as render-cache data.
        applySourceBlockProjectionMetadata(element, sourceBlock, state.doc);
        return element;
    });

    if (!previous) {
        const fragment = document.createDocumentFragment();
        for (const block of nextBlocks) fragment.append(block);
        editor.replaceChildren(fragment);
    } else {
        reconcileEditorBlocks(editor, currentBlocks, nextBlocks);
    }
    registerProjectedBlocks(nextBlocks);
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
        renderBlockPropertyKeys.every((key) => block[key] === previousBlock[key])
    );
}

function updateProjectedBlock(element: HTMLElement, block: ParsedBlock): HTMLElement {
    const canUpdateCodeContent = block.type === "code" && readBlockCodeFenceClosed(element) === block.codeFenceClosed;
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

function reconcileEditorBlocks(editor: HTMLElement, currentBlocks: HTMLElement[], nextBlocks: HTMLElement[]): void {
    if (editor.children.length === nextBlocks.length && currentBlocks.length === nextBlocks.length &&
        currentBlocks.every((block, index) => block === nextBlocks[index])) {
        return;
    }
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

function readParsedBlockFromSourceState(state: EditorState, block: SourceBlock): ParsedBlock {
    const parsed: ParsedBlock = {
        type: block.type,
        text: state.doc.slice(block.contentFrom, block.contentTo),
    };
    function copyProperty<K extends typeof renderBlockPropertyKeys[number]>(key: K): void {
        parsed[key] = block[key];
    }
    renderBlockPropertyKeys.forEach(copyProperty);
    return parsed;
}
