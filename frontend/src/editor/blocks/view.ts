import type { DocumentReferenceMap } from "../../formats/types";
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
import { caretSpacerCharacter, getRenderedContentText } from "../selection/rendered-content-dom";
import { escapeHtml } from "../../utils/text";
import { readMathSourceText } from "../../formats/markdown/math";

type BlockRenderContext = {
    references: DocumentReferenceMap;
    activeFilePath: string | null;
    renderInlineContent: (text: string, references: DocumentReferenceMap) => string;
    renderBlockContent?: (type: BlockType, text: string, references: DocumentReferenceMap) => string | null;
    hydrateRenderedContent?: (content: HTMLElement, activeFilePath: string | null) => void;
    readBlockSource?: (block: HTMLElement, type: BlockType, text: string) => BlockSource;
};

let renderContext: BlockRenderContext = {
    references: {},
    activeFilePath: null,
    renderInlineContent: renderPlainInlineContent,
};

export function configureBlockView(context: Partial<BlockRenderContext>): void {
    renderContext = { ...renderContext, ...context };
    renderContext.renderInlineContent = context.renderInlineContent ?? renderPlainInlineContent;
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
        delete content.dataset.renderedMarkdown;
        return;
    }

    const blockHtml = renderContext.renderBlockContent?.(type, text, renderContext.references);
    if (blockHtml !== undefined && blockHtml !== null) {
        renderPreviewBlockContent(content, text, blockHtml, `markdown-${type}-preview`, source);
        content.dataset.renderedMarkdown = blockHtml;
        renderContext.hydrateRenderedContent?.(content, renderContext.activeFilePath);
        return;
    }

    if (isPlainTextBlockType(type) || isOpenFencedCodeParagraph(type, text)) {
        renderPlainTextBlockContent(content, text, source);
        delete content.dataset.renderedMarkdown;
        return;
    }

    if (isAtomicBlockType(type)) {
        renderAtomicBlockContent(content, source);
        delete content.dataset.renderedMarkdown;
        return;
    }

    const html = renderBlockInnerHtml(block, type, text, source);

    content.innerHTML = html;
    content.dataset.renderedMarkdown = html;
    renderContext.hydrateRenderedContent?.(content, renderContext.activeFilePath);
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

    if (content.dataset.renderedMarkdown === html) {
        return null;
    }

    content.innerHTML = html;
    content.dataset.renderedMarkdown = html;
    renderContext.hydrateRenderedContent?.(content, renderContext.activeFilePath);

    return Math.min(offset, getBlockText(block).length);
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

    return renderContext.renderInlineContent(text, renderContext.references);
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
    return headingTypes.has(type) || isStandaloneBlockType(type) ? "paragraph" : type;
}

export function isRichTextBlockType(type: BlockType): boolean {
    return !isStandaloneBlockType(type);
}

function isStandaloneBlockType(type: BlockType): boolean {
    return isPlainTextBlockType(type) || isAtomicBlockType(type) || type === "table" || type === "math";
}

function isPlainTextBlockType(type: BlockType): boolean {
    return type === "code" || type === "source" || type === "reference";
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
        type === "math"
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
    return Array.from(editor.querySelectorAll<HTMLElement>("[data-block]"));
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

export function syncFirstBlockPlaceholder(): void {
    const [firstBlock, ...remainingBlocks] = getEditorBlocks();

    if (!firstBlock) {
        return;
    }

    const firstContent = getBlockContent(firstBlock);
    const firstType = readBlockType(firstBlock.dataset.type);

    // if (firstType === "paragraph" || firstType === "source") {
    //     firstContent.dataset.placeholder = "";
    // } else {
    //     delete firstContent.dataset.placeholder;
    // }

    for (const block of remainingBlocks) {
        delete getBlockContent(block).dataset.placeholder;
    }
}
