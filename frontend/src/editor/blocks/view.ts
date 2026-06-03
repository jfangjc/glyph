import type { DocumentReferenceMap, DocumentRenderContext, PlainTextHighlightPolicy } from "../../formats/types";
import { blockLabels, headingTypes, readBlockType, type BlockType, type ParsedBlock } from "./model";
import {
    renderAtomicBlockContent,
    renderBlockSourceHtml,
    renderCodeBlockContent,
    getBlockSourceElement,
    renderPlainTextBlockContent,
    renderPreviewBlockContent,
    type BlockSource,
} from "./rendering";
import { getElement } from "../../utils/dom";
import {
    caretSpacerCharacter,
    findRenderedContentTextPosition,
    getRenderedContentBoundaryOffset,
    getRenderedContentText,
} from "../selection/rendered-content-dom";
import { escapeHtml } from "../../utils/text";
import { readMathSourceText } from "../../formats/markdown/math";

export type BlockEditingKind = "rich" | "plain" | "source-preview" | "atomic";

type BlockRenderContext = {
    context: DocumentRenderContext;
    references: DocumentReferenceMap;
    activeFilePath: string | null;
    renderInlineContent: (text: string, context: DocumentRenderContext) => string;
    renderPlainTextContent?: (type: BlockType, text: string) => string | null;
    renderBlockContent?: (type: BlockType, text: string, context: DocumentRenderContext) => string | null;
    hydrateRenderedContent?: (content: HTMLElement, activeFilePath: string | null) => void;
    readBlockSource?: (block: HTMLElement, type: BlockType, text: string) => BlockSource;
    plainTextHighlightPolicy?: PlainTextHighlightPolicy;
};

let renderContext: BlockRenderContext = {
    context: { references: {} },
    references: {},
    activeFilePath: null,
    renderInlineContent: renderPlainInlineContent,
};

type RenderCacheEntry = {
    inlineHtml?: string;
    inlineRevision?: number;
    previewHtml?: string;
    previewRevision?: number;
    plainText?: {
        text: string;
        highlightedHtml: string | null;
        revision: number;
    };
};

type PlainTextHighlightResult = {
    html: string | null;
    delayed: boolean;
};

const renderCache = new WeakMap<HTMLElement, RenderCacheEntry>();
const pendingPlainTextHighlights = new WeakMap<HTMLElement, { timer: number; text: string; revision: number }>();
let renderRevision = 0;

export function configureBlockView(context: Partial<BlockRenderContext>): void {
    const nextContext = { ...renderContext, ...context };
    nextContext.context = context.context ?? { references: context.references ?? nextContext.references };
    nextContext.references = nextContext.context.references;
    nextContext.renderInlineContent = context.renderInlineContent ?? renderPlainInlineContent;

    if (didRenderContextChange(renderContext, nextContext)) {
        renderRevision += 1;
    }

    renderContext = nextContext;
}

export function createBlock(type: BlockType = "paragraph", text = "", options: Partial<ParsedBlock> = {}): HTMLElement {
    const blockTemplate = getElement<HTMLTemplateElement>("block-template");
    const fragment = blockTemplate.content.cloneNode(true) as DocumentFragment;
    const block = fragment.querySelector<HTMLElement>("[data-block]");

    if (!block) {
        throw new Error("Block template is missing [data-block]");
    }

    applyBlockProperties(block, { ...options, type });
    setBlockText(block, text);
    return block;
}

export function applyBlockProperties(block: HTMLElement, options: Partial<ParsedBlock> & { type: BlockType }): void {
    setBlockType(block, options.type);
    setBlockIndent(block, options.indent ?? 0);
    setBlockListMarker(block, options.listMarker);
    setBlockListNumber(block, options.listNumber);
    setBlockQuoteLevel(block, options.quoteLevel);
    setTodoChecked(block, options.checked ?? false);
    setCodeFence(block, options.codeFence);
    setCodeInfo(block, options.codeInfo ?? "");
    setRuleMarker(block, options.ruleMarker);
    setMathSource(block, options.mathSource);
    setBlockHeadingId(block, options.headingId, options.headingIdExplicit);
}

export function setBlockType(block: HTMLElement, type: BlockType): void {
    const content = getBlockContent(block);

    block.dataset.type = type;
    content.setAttribute("aria-label", `${blockLabels[type]} block`);

    if (!isIndentableListBlockType(type)) {
        setBlockIndent(block, 0);
    }

    if (!usesBulletListMarker(type)) {
        delete block.dataset.listMarker;
    }

    if (type !== "ordered-list") {
        delete block.dataset.listNumber;
    }

    if (type !== "code") {
        delete block.dataset.codeFence;
        delete block.dataset.codeInfo;
        delete content.dataset.codeInfo;
    }

    if (type !== "rule") {
        delete block.dataset.ruleMarker;
    }

    if (type !== "quote") {
        delete block.dataset.quoteLevel;
    }

    if (type !== "math") {
        delete block.dataset.mathSource;
    }

    if (!headingTypes.has(type)) {
        delete block.dataset.headingId;
        delete block.dataset.headingIdExplicit;
        block.removeAttribute("id");
    }
}

export function setBlockText(block: HTMLElement, text: string): void {
    const content = getBlockContent(block);
    const type = readBlockType(block.dataset.type);
    const source = renderContext.readBlockSource?.(block, type, text) ?? {};

    if (text !== "") {
        delete block.dataset.transient;
    }
    if (type === "code") {
        renderCodeBlockContent(content, text, source);
        clearRenderCache(content);
        return;
    }

    const blockHtml = renderContext.renderBlockContent?.(type, text, renderContext.context);
    if (blockHtml !== undefined && blockHtml !== null) {
        const previewHtml = `${serializeBlockSource(source)}\u0000${blockHtml}`;
        const cache = getRenderCache(content);
        if (cache.previewHtml === previewHtml && cache.previewRevision === renderRevision) {
            return;
        }

        renderPreviewBlockContent(content, text, blockHtml, `markdown-${type}-preview`, source);
        cache.previewHtml = previewHtml;
        cache.previewRevision = renderRevision;
        renderContext.hydrateRenderedContent?.(content, renderContext.activeFilePath);
        return;
    }

    if (isPlainTextBlockType(type) || isOpenFencedCodeParagraph(type, text)) {
        const highlight = readPlainTextHighlight(type, text, block, content, source);
        renderPlainTextBlockContent(content, text, source, highlight.html);
        syncPlainTextHighlightCache(content, text, highlight.html, highlight.delayed);
        clearInlineAndPreviewCache(content);
        return;
    }

    if (isAtomicBlockType(type)) {
        renderAtomicBlockContent(content, source);
        clearRenderCache(content);
        return;
    }

    const html = renderBlockInnerHtml(block, type, text, source);

    const cache = getRenderCache(content);
    if (cache.inlineHtml === html && cache.inlineRevision === renderRevision) {
        return;
    }

    content.innerHTML = html;
    cache.inlineHtml = html;
    cache.inlineRevision = renderRevision;
    renderContext.hydrateRenderedContent?.(content, renderContext.activeFilePath);
}

export function ensureBlockSourceRendered(block: HTMLElement): void {
    const content = getBlockContent(block);
    if (content.querySelector(".format-block-source")) {
        return;
    }

    const type = readBlockType(block.dataset.type);
    if (!canRecoverMissingBlockSource(block, type)) {
        return;
    }

    const text = getBlockText(block);
    const source = renderContext.readBlockSource?.(block, type, text) ?? {};
    if (!hasRenderableBlockSource(source)) {
        return;
    }

    clearRenderCache(content);
    setBlockText(block, text);
}

export function rerenderInlineBlockContent(block: HTMLElement, offset: number): number | null {
    const type = readBlockType(block.dataset.type);
    const text = getBlockText(block);

    if (!isRichTextBlockType(type)) {
        return null;
    }

    if (isOpenFencedCodeParagraph(type, text)) {
        setBlockText(block, text);
        return Math.min(offset, text.length);
    }

    const content = getBlockContent(block);
    const html = renderBlockInnerHtml(block, type, text, renderContext.readBlockSource?.(block, type, text) ?? {});
    const cache = getRenderCache(content);

    if (cache.inlineHtml === html && cache.inlineRevision === renderRevision) {
        return null;
    }

    content.innerHTML = html;
    cache.inlineHtml = html;
    cache.inlineRevision = renderRevision;
    renderContext.hydrateRenderedContent?.(content, renderContext.activeFilePath);

    return Math.min(offset, getBlockText(block).length);
}

export function rerenderPlainTextBlockContent(block: HTMLElement, offset: number): number | null {
    const type = readBlockType(block.dataset.type);
    if (!isPlainTextBlockType(type)) {
        return null;
    }

    const content = getBlockContent(block);
    const text = getBlockText(block);
    const source = renderContext.readBlockSource?.(block, type, text) ?? {};
    const highlight = readPlainTextHighlight(type, text, block, content, source);
    const cache = getRenderCache(content);
    if (
        !highlight.delayed &&
        (highlight.html === null ||
            (cache.plainText?.text === text &&
                cache.plainText.highlightedHtml === highlight.html &&
                cache.plainText.revision === renderRevision))
    ) {
        return null;
    }

    renderPlainTextBlockContent(content, text, source, highlight.html);
    syncPlainTextHighlightCache(content, text, highlight.html, highlight.delayed);
    clearInlineAndPreviewCache(content);

    return Math.min(offset, text.length);
}

function readPlainTextHighlight(
    type: BlockType,
    text: string,
    block: HTMLElement,
    content: HTMLElement,
    source: BlockSource,
): PlainTextHighlightResult {
    const renderPlainTextContent = renderContext.renderPlainTextContent;
    if (!renderPlainTextContent) {
        cancelPendingPlainTextHighlight(content);
        return { html: null, delayed: false };
    }

    const policy = renderContext.plainTextHighlightPolicy;
    if (policy && text.length >= policy.liveMaxChars) {
        schedulePlainTextHighlight(block, content, type, text, source, policy);
        return { html: null, delayed: true };
    }

    cancelPendingPlainTextHighlight(content);
    return { html: renderPlainTextContent(type, text), delayed: false };
}

function syncPlainTextHighlightCache(
    content: HTMLElement,
    text: string,
    highlightedHtml: string | null,
    delayed: boolean,
): void {
    const cache = getRenderCache(content);
    if (delayed) {
        delete cache.plainText;
        return;
    }

    cache.plainText = {
        text,
        highlightedHtml,
        revision: renderRevision,
    };
}

function schedulePlainTextHighlight(
    block: HTMLElement,
    content: HTMLElement,
    type: BlockType,
    text: string,
    source: BlockSource,
    policy: PlainTextHighlightPolicy,
): void {
    const pending = pendingPlainTextHighlights.get(content);
    if (pending?.text === text && pending.revision === renderRevision) {
        return;
    }

    cancelPendingPlainTextHighlight(content);
    const revision = renderRevision;
    const timer = window.setTimeout(() => {
        pendingPlainTextHighlights.delete(content);
        if (!block.isConnected || !content.isConnected || readBlockType(block.dataset.type) !== type) {
            return;
        }

        if (getBlockText(block) !== text) {
            return;
        }

        const renderPlainTextContent = renderContext.renderPlainTextContent;
        if (!renderPlainTextContent) {
            return;
        }

        const activeOffset = readCurrentBlockOffset(block);
        const highlightedHtml = renderPlainTextContent(type, text);
        const nextSource = renderContext.readBlockSource?.(block, type, text) ?? source;

        renderPlainTextBlockContent(content, text, nextSource, highlightedHtml);
        getRenderCache(content).plainText = {
            text,
            highlightedHtml,
            revision: renderRevision,
        };

        if (activeOffset !== null) {
            focusBlockContentAtOffset(block, Math.min(activeOffset, text.length));
        }
    }, policy.delayMs);

    pendingPlainTextHighlights.set(content, { timer, text, revision });
}

function cancelPendingPlainTextHighlight(content: HTMLElement): void {
    const pending = pendingPlainTextHighlights.get(content);
    if (!pending) {
        return;
    }

    window.clearTimeout(pending.timer);
    pendingPlainTextHighlights.delete(content);
}

function getRenderCache(content: HTMLElement): RenderCacheEntry {
    let cache = renderCache.get(content);
    if (!cache) {
        cache = {};
        renderCache.set(content, cache);
    }
    return cache;
}

function clearRenderCache(content: HTMLElement): void {
    cancelPendingPlainTextHighlight(content);
    renderCache.delete(content);
}

function clearInlineAndPreviewCache(content: HTMLElement): void {
    const cache = getRenderCache(content);
    delete cache.inlineHtml;
    delete cache.inlineRevision;
    delete cache.previewHtml;
    delete cache.previewRevision;
}

function serializeBlockSource(source: BlockSource): string {
    return [
        source.prefix ?? "",
        source.prefixEditable === false ? "0" : "1",
        source.suffix ?? "",
        source.atomic ?? "",
    ].join("\u0000");
}

function hasRenderableBlockSource(source: BlockSource): boolean {
    return source.prefix !== undefined || source.suffix !== undefined || source.atomic !== undefined;
}

function canRecoverMissingBlockSource(block: HTMLElement, type: BlockType): boolean {
    if (type === "table" || type === "html") {
        return false;
    }

    return type !== "math" || Boolean(block.dataset.mathSource);
}

function didRenderContextChange(previous: BlockRenderContext, next: BlockRenderContext): boolean {
    return (
        previous.context !== next.context ||
        previous.references !== next.references ||
        previous.activeFilePath !== next.activeFilePath ||
        previous.renderInlineContent !== next.renderInlineContent ||
        previous.renderPlainTextContent !== next.renderPlainTextContent ||
        previous.renderBlockContent !== next.renderBlockContent ||
        previous.hydrateRenderedContent !== next.hydrateRenderedContent ||
        previous.readBlockSource !== next.readBlockSource ||
        previous.plainTextHighlightPolicy !== next.plainTextHighlightPolicy
    );
}

function readCurrentBlockOffset(block: HTMLElement): number | null {
    const content = getBlockContent(block);
    const selection = document.getSelection();
    const focusNode = selection?.focusNode;

    if (!selection?.isCollapsed || !focusNode || (focusNode !== content && !content.contains(focusNode))) {
        return null;
    }

    return getRenderedContentBoundaryOffset(content, focusNode, selection.focusOffset);
}

function focusBlockContentAtOffset(block: HTMLElement, offset: number): void {
    const editor = getElement<HTMLElement>("editor");
    const content = getBlockContent(block);
    const selection = document.getSelection();
    const range = document.createRange();
    const position = findRenderedContentTextPosition(content, Math.max(0, offset)) ?? {
        node: content,
        offset: content.childNodes.length,
    };

    editor.focus();
    range.setStart(position.node, position.offset);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
}

function renderBlockInnerHtml(block: HTMLElement, type: BlockType, text: string, source: BlockSource): string {
    return (
        renderBlockSourceHtml(source.prefix, "prefix", source.prefixEditable ?? true) +
        renderBlockEditableTextHtml(text, source) +
        renderBlockSourceHtml(source.suffix, "suffix")
    );
}

function renderBlockEditableTextHtml(text: string, source: BlockSource): string {
    if (text === "" && source.prefix && source.prefixEditable === false) {
        return caretSpacerCharacter;
    }

    return renderContext.renderInlineContent(text, renderContext.context);
}

function renderPlainInlineContent(text: string): string {
    return escapeHtml(text).replace(/\n/g, '<br data-source-raw="&#10;">');
}

function isOpenFencedCodeParagraph(type: BlockType, text: string): boolean {
    if (type !== "paragraph" || !text.includes("\n")) {
        return false;
    }

    return Boolean(
        text
            .split("\n")[0]
            ?.trim()
            .match(/^(`{3,}|~{3,})(.*)$/),
    );
}

export function setBlockIndent(block: HTMLElement, indent: number): void {
    if (isIndentableListBlockType(readBlockType(block.dataset.type)) && indent > 0) {
        block.dataset.indent = String(Math.min(indent, 3));
        return;
    }

    delete block.dataset.indent;
}

export function setBlockListMarker(block: HTMLElement, marker: string | undefined): void {
    const type = readBlockType(block.dataset.type);

    if (usesBulletListMarker(type)) {
        block.dataset.listMarker = marker && ["-", "*", "+"].includes(marker) ? marker : "-";
        return;
    }

    delete block.dataset.listMarker;
}

export function setBlockListNumber(block: HTMLElement, value: string | undefined): void {
    if (readBlockType(block.dataset.type) === "ordered-list") {
        block.dataset.listNumber = value && /^\d{1,9}$/.test(value) ? value : "1";
        return;
    }

    delete block.dataset.listNumber;
}

function setBlockQuoteLevel(block: HTMLElement, level: number | undefined): void {
    if (readBlockType(block.dataset.type) === "quote" && level && level > 1) {
        block.dataset.quoteLevel = String(Math.min(level, 6));
        return;
    }

    delete block.dataset.quoteLevel;
}

function setTodoChecked(block: HTMLElement, checked: boolean): void {
    getTodoCheckbox(block).checked = checked;
}

export function setCodeFence(block: HTMLElement, codeFence: string | undefined): void {
    if (readBlockType(block.dataset.type) === "code" && codeFence && /^(`{3,}|~{3,})$/.test(codeFence)) {
        block.dataset.codeFence = codeFence;
        return;
    }

    delete block.dataset.codeFence;
}

export function setCodeInfo(block: HTMLElement, codeInfo: string): void {
    const content = getBlockContent(block);

    if (readBlockType(block.dataset.type) === "code" && codeInfo) {
        block.dataset.codeInfo = codeInfo;
        content.dataset.codeInfo = codeInfo;
        return;
    }

    delete block.dataset.codeInfo;
    delete content.dataset.codeInfo;
}

function setRuleMarker(block: HTMLElement, ruleMarker: string | undefined): void {
    if (
        readBlockType(block.dataset.type) === "rule" &&
        ruleMarker &&
        /^(\*\s*){3,}$|^(-\s*){3,}$|^(_\s*){3,}$/.test(ruleMarker)
    ) {
        block.dataset.ruleMarker = ruleMarker;
        return;
    }

    delete block.dataset.ruleMarker;
}

export function setBlockHeadingId(block: HTMLElement, headingId: string | undefined, explicit = false): void {
    if (!headingTypes.has(readBlockType(block.dataset.type))) {
        delete block.dataset.headingId;
        delete block.dataset.headingIdExplicit;
        block.removeAttribute("id");
        return;
    }

    const normalized = normalizeHeadingId(headingId);
    if (normalized) {
        block.dataset.headingId = normalized;
        block.dataset.headingIdExplicit = explicit ? "true" : "false";
        block.id = normalized;
        return;
    }

    delete block.dataset.headingId;
    delete block.dataset.headingIdExplicit;
    block.removeAttribute("id");
}

function normalizeHeadingId(value: string | undefined): string {
    return (value ?? "").trim().replace(/\s+/g, "-");
}

function setMathSource(block: HTMLElement, mathSource: string | undefined): void {
    if (readBlockType(block.dataset.type) === "math" && mathSource !== undefined) {
        block.dataset.mathSource = mathSource;
        return;
    }

    delete block.dataset.mathSource;
}

export function getBlockText(block: HTMLElement): string {
    const content = getBlockContent(block);
    const type = readBlockType(block.dataset.type);

    if (type === "table") {
        const source = getBlockSourceElement(content, "atomic");
        if (source) {
            return source.textContent ?? "";
        }
    }

    if (type === "math") {
        const source = getBlockSourceElement(content, "atomic");
        if (source) {
            return readMathSourceText(source.textContent ?? "");
        }
    }

    if (type === "html" || type === "definition-list") {
        const source = getBlockSourceElement(content, "atomic");
        return source?.textContent ?? "";
    }

    if (isPlainTextBlockType(type)) {
        return getRenderedContentText(content);
    }

    if (isAtomicBlockType(type)) {
        return "";
    }

    return getRenderedContentText(content);
}

export function readBlockIndent(block: HTMLElement): number {
    const indent = Number(block.dataset.indent ?? 0);
    return Number.isFinite(indent) ? Math.max(0, Math.min(indent, 3)) : 0;
}

export function readBlockListMarker(block: HTMLElement): string | undefined {
    const marker = block.dataset.listMarker;
    return marker && ["-", "*", "+"].includes(marker) ? marker : undefined;
}

export function readBlockListNumber(block: HTMLElement): string | undefined {
    const number = block.dataset.listNumber;
    return number && /^\d{1,9}$/.test(number) ? number : undefined;
}

export function readBlockCodeFence(block: HTMLElement): string | undefined {
    const codeFence = block.dataset.codeFence;
    return codeFence && /^(`{3,}|~{3,})$/.test(codeFence) ? codeFence : undefined;
}

export function readNextListNumber(block: HTMLElement): string {
    const number = Number(readBlockListNumber(block) ?? "1");
    return Number.isFinite(number) ? String(number + 1) : "1";
}

export function readBlockQuoteLevel(block: HTMLElement): number | undefined {
    const level = Number(block.dataset.quoteLevel ?? 1);
    return Number.isFinite(level) && level > 1 ? level : undefined;
}

export function readBlockHeadingId(block: HTMLElement): string | undefined {
    return block.dataset.headingId;
}

export function readBlockHeadingIdExplicit(block: HTMLElement): boolean {
    return block.dataset.headingIdExplicit === "true";
}

export function readBlockRuleMarker(block: HTMLElement): string | undefined {
    const ruleMarker = block.dataset.ruleMarker;
    return ruleMarker && /^(\*\s*){3,}$|^(-\s*){3,}$|^(_\s*){3,}$/.test(ruleMarker) ? ruleMarker : undefined;
}

export function readEditorBlock(block: HTMLElement): ParsedBlock {
    const type = readBlockType(block.dataset.type);

    return {
        type,
        text: getBlockText(block),
        indent: readBlockIndent(block),
        checked: type === "todo" ? getTodoCheckbox(block).checked : undefined,
        codeFence: readBlockCodeFence(block),
        codeInfo: block.dataset.codeInfo,
        listMarker: readBlockListMarker(block),
        listNumber: readBlockListNumber(block),
        quoteLevel: readBlockQuoteLevel(block),
        ruleMarker: readBlockRuleMarker(block),
        mathSource: type === "math" ? block.dataset.mathSource : undefined,
        headingId: headingTypes.has(type) ? readBlockHeadingId(block) : undefined,
        headingIdExplicit: headingTypes.has(type) ? readBlockHeadingIdExplicit(block) : undefined,
    };
}

export function getSerializableEditorBlocks(): HTMLElement[] {
    const blocks = getEditorBlocks();
    let endIndex = blocks.length;

    while (endIndex > 1 && isEmptyTransientParagraph(blocks[endIndex - 1])) {
        endIndex -= 1;
    }

    return blocks.slice(0, endIndex);
}

function isEmptyTransientParagraph(block: HTMLElement): boolean {
    return (
        block.dataset.transient === "true" &&
        readBlockType(block.dataset.type) === "paragraph" &&
        getBlockText(block) === ""
    );
}

export function readSplitContinuationType(type: BlockType): BlockType {
    return headingTypes.has(type) || readBlockEditingKind(type) !== "rich" ? "paragraph" : type;
}

export function isRichTextBlockType(type: BlockType): boolean {
    return readBlockEditingKind(type) === "rich";
}

export function readBlockEditingKind(type: BlockType): BlockEditingKind {
    if (isPlainTextBlockType(type)) {
        return "plain";
    }

    if (type === "table" || type === "math" || type === "html" || type === "definition-list") {
        return "source-preview";
    }

    if (isAtomicBlockType(type)) {
        return "atomic";
    }

    return "rich";
}

export function canMergeBlockText(leftType: BlockType, rightType: BlockType): boolean {
    return readBlockEditingKind(leftType) === "rich" && readBlockEditingKind(rightType) === "rich";
}

function isPlainTextBlockType(type: BlockType): boolean {
    return type === "code" || type === "source" || type === "reference" || type === "footnote-definition";
}

export function isMultilinePlainTextBlockType(type: BlockType): boolean {
    return type === "code" || type === "source";
}

function isAtomicBlockType(type: BlockType): boolean {
    return type === "rule";
}

export function isIndentableListBlockType(type: BlockType): boolean {
    return type === "list" || type === "ordered-list" || type === "todo";
}

function usesBulletListMarker(type: BlockType): boolean {
    return type === "list" || type === "todo";
}

export function shouldResetEmptyBlock(type: BlockType): boolean {
    return (
        isIndentableListBlockType(type) ||
        type === "quote" ||
        type === "reference" ||
        type === "table" ||
        type === "math" ||
        type === "html" ||
        type === "definition-list" ||
        type === "footnote-definition"
    );
}

export function getBlockContent(block: HTMLElement): HTMLElement {
    const content = block.querySelector<HTMLElement>(".block-content");
    if (!content) {
        throw new Error("Block is missing .block-content");
    }
    return content;
}

export function getTodoCheckbox(block: HTMLElement): HTMLInputElement {
    const checkbox = block.querySelector<HTMLInputElement>(".todo-checkbox");
    if (!checkbox) {
        throw new Error("Block is missing .todo-checkbox");
    }

    return checkbox;
}

export function findBlock(target: EventTarget | Node | null): HTMLElement | null {
    if (!(target instanceof Node)) {
        return null;
    }

    const element = target instanceof Element ? target : target.parentElement;
    return element?.closest("[data-block]") as HTMLElement | null;
}

export function getEditorBlocks(): HTMLElement[] {
    const editor = getElement<HTMLElement>("editor");
    return Array.from(editor.children).filter(
        (child): child is HTMLElement => child instanceof HTMLElement && child.matches("[data-block]"),
    );
}

export function getBlockIndex(block: HTMLElement): number {
    return getEditorBlocks().indexOf(block);
}

export function getEditorBlockRange(startBlock: HTMLElement, endBlock: HTMLElement): HTMLElement[] {
    const blocks = getEditorBlocks();
    const startIndex = blocks.indexOf(startBlock);
    const endIndex = blocks.indexOf(endBlock);

    if (startIndex < 0 || endIndex < 0) {
        return [];
    }

    const rangeStart = Math.min(startIndex, endIndex);
    const rangeEnd = Math.max(startIndex, endIndex);
    return blocks.slice(rangeStart, rangeEnd + 1);
}

export function getSiblingBlock(block: HTMLElement, direction: "previous" | "next"): HTMLElement | null {
    const sibling = direction === "previous" ? block.previousElementSibling : block.nextElementSibling;
    return sibling instanceof HTMLElement && sibling.matches("[data-block]") ? sibling : null;
}

export function clearBlockProperties(block: HTMLElement): void {
    const text = getBlockText(block);

    setBlockType(block, "paragraph");
    setTodoChecked(block, false);
    setBlockText(block, text);
}

export function ensureEditableBlockAfter(block: HTMLElement): void {
    if (getSiblingBlock(block, "next")) {
        return;
    }

    const nextBlock = createBlock("paragraph");
    nextBlock.dataset.transient = "true";
    block.after(nextBlock);
}

export function commitTransientBlock(block: HTMLElement): void {
    delete block.dataset.transient;
}
