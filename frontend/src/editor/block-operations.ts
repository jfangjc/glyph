import {
    getMarkdownText,
} from "../formats/markdown/dom";
import { parseMarkdownFragment } from "../formats/markdown/document";
import { parseMarkdownReferenceDefinition } from "../formats/markdown/references";
import { markdownShortcuts } from "../formats/markdown/shortcuts";
import {
    clearBlockProperties,
    createBlock,
    ensureEditableBlockAfter,
    getBlockContent,
    getBlockText,
    getSiblingBlock,
    isIndentableListBlockType,
    isInlineMarkdownBlockType,
    readBlockIndent,
    readBlockListMarker,
    readBlockQuoteLevel,
    readNextListNumber,
    readSplitContinuationType,
    setBlockIndent,
    setBlockListMarker,
    setBlockListNumber,
    setCodeFence,
    setBlockText,
    setBlockType,
    setCodeInfo,
    shouldResetEmptyBlock,
    syncFirstBlockPlaceholder,
} from "./block-view";
import { readBlockType, type ParsedBlock } from "./block-model";
import {
    focusBlock,
    focusBlockAtOffset,
    focusPlainTextElement,
    getCaretOffset,
    getCollapsedSelectionRect,
    getCurrentBlockOffset,
    getSelectedBlockRange,
    isCaretAtBlockEdge,
    readLineHeight,
} from "./caret";
import {
    deleteSelectedContent,
    insertTextAtCaret,
} from "./selection-commands";

export function splitBlock(block: HTMLElement): void {
    const content = getBlockContent(block);
    const selection = document.getSelection();
    const text = getBlockText(block);
    const offset = selection?.focusNode
        ? getCaretOffset(content, selection.focusNode, selection.focusOffset)
        : text.length;
    const currentType = readBlockType(block.dataset.type);

    if (text === "" && shouldResetEmptyBlock(currentType)) {
        clearBlockProperties(block);
        focusBlockAtOffset(block, 0);
        return;
    }

    const before = text.slice(0, offset);
    const after = text.slice(offset);
    const nextType = readSplitContinuationType(currentType);
    const nextBlock = createBlock(nextType, after, {
        indent: isIndentableListBlockType(nextType) ? readBlockIndent(block) : 0,
        listMarker: readBlockListMarker(block),
        listNumber: nextType === "ordered-list" ? readNextListNumber(block) : undefined,
        quoteLevel: nextType === "quote" ? readBlockQuoteLevel(block) : undefined,
    });

    setBlockText(block, before);
    block.after(nextBlock);
    focusBlockAtOffset(nextBlock, 0);
}

export function startCodeBlockFromFence(block: HTMLElement): boolean {
    if (readBlockType(block.dataset.type) !== "paragraph" || !isCaretAtBlockEdge(block, "end")) {
        return false;
    }

    const match = getBlockText(block).match(/^(`{3,}|~{3,})(.*)$/);
    if (!match) {
        return false;
    }

    setBlockType(block, "code");
    setCodeInfo(block, match[2].trim());
    setBlockText(block, "");
    ensureEditableBlockAfter(block);
    focusBlockAtOffset(block, 0);
    return true;
}

export function completeCodeBlockFromFencedParagraph(block: HTMLElement): boolean {
    if (readBlockType(block.dataset.type) !== "paragraph") {
        return false;
    }

    const completedCodeBlock = readCompletedCodeFenceBlock(getBlockText(block));
    if (!completedCodeBlock) {
        return false;
    }

    const offset = getCurrentBlockOffset(block);

    setBlockType(block, "code");
    setCodeFence(block, completedCodeBlock.codeFence);
    setCodeInfo(block, completedCodeBlock.codeInfo ?? "");
    setBlockText(block, completedCodeBlock.text);
    focusCompletedCodeBlock(block, completedCodeBlock, offset);
    removeEmptyTransientBlockAfter(block);
    return true;
}

export function insertLineBreakInOpenCodeFenceParagraph(block: HTMLElement): boolean {
    if (readBlockType(block.dataset.type) !== "paragraph") {
        return false;
    }

    const text = getBlockText(block);
    if (!isOpenCodeFenceParagraph(text)) {
        return false;
    }

    insertTextAtCaret(block, "\n");
    return true;
}

export function removeTrailingLineBreakInOpenCodeFenceParagraph(block: HTMLElement): boolean {
    if (readBlockType(block.dataset.type) !== "paragraph") {
        return false;
    }

    const text = getBlockText(block);
    if (!text.endsWith("\n") || !isOpenCodeFenceParagraph(text) || getCurrentBlockOffset(block) !== text.length) {
        return false;
    }

    setBlockText(block, text.slice(0, -1));
    focusBlockAtOffset(block, text.length - 1, { scroll: "none" });
    return true;
}

export function removeTrailingLineBreakInCodeBlock(block: HTMLElement): boolean {
    if (readBlockType(block.dataset.type) !== "code") {
        return false;
    }

    const text = getBlockText(block);
    if (!text.endsWith("\n") || getCurrentBlockOffset(block) !== text.length) {
        return false;
    }

    setBlockText(block, text.slice(0, -1));
    focusBlockAtOffset(block, text.length - 1, { scroll: "none" });
    return true;
}

export function applyMarkdownShortcut(block: HTMLElement): boolean {
    const text = getBlockText(block);
    const referenceDefinition = parseMarkdownReferenceDefinition(text);
    if (referenceDefinition) {
        setBlockType(block, "reference");
        setBlockText(block, text);
        ensureEditableBlockAfter(block);
        focusBlock(block);
        return true;
    }

    const shortcut = markdownShortcuts.find((candidate) =>
        candidate.exact ? text === candidate.marker : text.startsWith(candidate.marker),
    );

    if (!shortcut) {
        return false;
    }

    setBlockType(block, shortcut.type);
    setBlockIndent(block, shortcut.indent ?? 0);
    setBlockListMarker(block, shortcut.listMarker);
    setBlockListNumber(block, shortcut.listNumber);
    setBlockText(block, text.slice(shortcut.marker.length));
    ensureEditableBlockAfter(block);

    if (shortcut.type === "rule") {
        const nextBlock = getSiblingBlock(block, "next");
        focusBlockAtOffset(nextBlock ?? block, 0);
        return true;
    }

    focusBlock(block);
    return true;
}

function isOpenCodeFenceParagraph(rawMarkdown: string): boolean {
    const lines = rawMarkdown.replace(/\r\n?/g, "\n").split("\n");
    const opening = lines[0]?.trim().match(/^(`{3,}|~{3,})(.*)$/);
    return Boolean(opening && !isClosingFenceLine(lines[lines.length - 1], opening[1]));
}

type CompletedCodeFenceBlock = ParsedBlock & {
    type: "code";
    openingLineLength: number;
    closingLineStart: number;
    closingLineLength: number;
};

function readCompletedCodeFenceBlock(rawMarkdown: string): CompletedCodeFenceBlock | null {
    const lines = rawMarkdown.replace(/\r\n?/g, "\n").split("\n");
    const opening = lines[0]?.trim().match(/^(`{3,}|~{3,})(.*)$/);
    if (!opening || lines.length < 2) {
        return null;
    }

    const closingLineIndex = lines.length - 1;
    if (!isClosingFenceLine(lines[closingLineIndex], opening[1])) {
        return null;
    }

    return {
        type: "code",
        text: lines.slice(1, closingLineIndex).join("\n"),
        codeFence: opening[1],
        codeInfo: opening[2].trim(),
        openingLineLength: lines[0].length,
        closingLineStart: lines.slice(0, closingLineIndex).join("\n").length + 1,
        closingLineLength: lines[closingLineIndex].length,
    };
}

function focusCompletedCodeBlock(block: HTMLElement, completedCodeBlock: CompletedCodeFenceBlock, rawOffset: number): void {
    if (rawOffset >= completedCodeBlock.closingLineStart) {
        block.dataset.markdownSourceActive = "true";
        const suffix = getBlockContent(block).querySelector<HTMLElement>(".markdown-block-source-suffix");
        if (suffix) {
            focusPlainTextElement(
                suffix,
                Math.min(rawOffset - completedCodeBlock.closingLineStart, completedCodeBlock.closingLineLength),
            );
            return;
        }
    }

    delete block.dataset.markdownSourceActive;
    focusBlockAtOffset(
        block,
        Math.min(readCodeBodyFocusOffset(completedCodeBlock, rawOffset), completedCodeBlock.text.length),
    );
}

function readCodeBodyFocusOffset(block: CompletedCodeFenceBlock, rawOffset: number): number {
    return Math.max(0, rawOffset - block.openingLineLength - 1);
}

function removeEmptyTransientBlockAfter(block: HTMLElement): void {
    const next = getSiblingBlock(block, "next");
    if (
        next?.dataset.transient === "true" &&
        readBlockType(next.dataset.type) === "paragraph" &&
        getBlockText(next) === ""
    ) {
        next.remove();
    }
}

function isClosingFenceLine(line: string, openingFence: string): boolean {
    const trimmed = line.trim();
    const fenceCharacter = openingFence[0];

    return (
        trimmed.length >= openingFence.length &&
        trimmed.split("").every((character) => character === fenceCharacter)
    );
}

export function insertPastedText(block: HTMLElement, text: string): void {
    const selectedBlock = deleteSelectedContent() ?? block;

    if (readBlockType(selectedBlock.dataset.type) === "code") {
        insertTextAtCaret(selectedBlock, text);
        return;
    }

    const content = getBlockContent(selectedBlock);
    const selection = document.getSelection();
    const currentText = getBlockText(selectedBlock);
    const offset = selection?.focusNode
        ? getCaretOffset(content, selection.focusNode, selection.focusOffset)
        : currentText.length;
    const before = currentText.slice(0, offset);
    const after = currentText.slice(offset);
    const isWholeBlockPaste = before === "" && after === "";

    if (isWholeBlockPaste && shouldParsePastedMarkdown(text)) {
        replaceBlockWithPastedMarkdown(selectedBlock, text);
        return;
    }

    const lines = text.split("\n");

    if (before === "" && lines.length > 1) {
        replaceBlockWithPastedMarkdown(selectedBlock, text, after);
        return;
    }

    if (lines.length === 1) {
        if (before === "" && replaceSingleLineBlockStartWithPastedMarkdown(selectedBlock, text, after)) {
            return;
        }

        setBlockText(selectedBlock, before + text + after);
        focusBlockAtOffset(selectedBlock, before.length + text.length);
        return;
    }

    setBlockText(selectedBlock, before + lines[0]);
    insertParsedPastedBlocksAfter(selectedBlock, lines.slice(1).join("\n"), after);
}

export function indentListBlocks(block: HTMLElement, delta: number): boolean {
    const selectedRange = getSelectedBlockRange();
    const blocks = selectedRange?.blocks ?? [block];
    const listBlocks = blocks.filter((candidate) => isIndentableListBlockType(readBlockType(candidate.dataset.type)));

    if (listBlocks.length === 0) {
        return false;
    }

    for (const listBlock of listBlocks) {
        setBlockIndent(listBlock, readBlockIndent(listBlock) + delta);
    }

    focusBlockAtOffset(block, getCurrentBlockOffset(block));
    return true;
}

export function removeOrMergeBackward(block: HTMLElement): boolean {
    const type = readBlockType(block.dataset.type);

    if (!isCaretAtBlockEdge(block, "start")) {
        return false;
    }

    if (type !== "paragraph") {
        clearBlockProperties(block);
        focusBlockAtOffset(block, 0);
        return true;
    }

    if (getBlockText(block) === "") {
        const previous = getSiblingBlock(block, "previous");
        if (previous) {
            block.remove();
            focusBlock(previous);
            return true;
        }

        return true;
    }

    const previous = getSiblingBlock(block, "previous");
    if (!previous) {
        return true;
    }

    const offset = getBlockText(previous).length;
    setBlockText(previous, getBlockText(previous) + getBlockText(block));
    block.remove();
    focusBlockAtOffset(previous, offset);
    return true;
}

export function mergeForward(block: HTMLElement): boolean {
    if (!isCaretAtBlockEdge(block, "end")) {
        return false;
    }

    const next = getSiblingBlock(block, "next");
    if (!next) {
        return true;
    }

    const offset = getBlockText(block).length;
    setBlockText(block, getBlockText(block) + getBlockText(next));
    next.remove();
    focusBlockAtOffset(block, offset);
    return true;
}

export function findVerticalMarkdownImageToken(
    block: HTMLElement,
    direction: "previous" | "next",
): HTMLElement | null {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.focusNode) {
        return null;
    }

    const caretRect = getCollapsedSelectionRect(selection);
    if (!caretRect) {
        const sibling = getSiblingBlock(block, direction);
        return sibling && isCaretAtBlockEdge(block, direction === "previous" ? "start" : "end")
            ? getOnlyInactiveImageToken(sibling)
            : null;
    }

    const sibling = getSiblingBlock(block, direction);
    const searchBlocks = sibling ? [block, sibling] : [block];
    const candidates = searchBlocks.flatMap((candidateBlock) =>
        Array.from(getBlockContent(candidateBlock).querySelectorAll<HTMLElement>(".markdown-image-token")),
    );
    const lineHeight = readLineHeight(getBlockContent(block));
    const maximumDistance = Math.max(lineHeight * 3, 72);
    let best: { token: HTMLElement; distance: number; horizontalDistance: number } | null = null;

    for (const token of candidates) {
        if (token.dataset.active === "true") {
            continue;
        }

        const tokenRect = token.getBoundingClientRect();
        const distance = direction === "previous" ? caretRect.top - tokenRect.bottom : tokenRect.top - caretRect.bottom;

        if (distance < -1 || distance > maximumDistance) {
            continue;
        }

        const caretX = caretRect.left + caretRect.width / 2;
        const tokenX = tokenRect.left + tokenRect.width / 2;
        const horizontalDistance = Math.abs(caretX - tokenX);

        if (
            !best ||
            distance < best.distance ||
            (distance === best.distance && horizontalDistance < best.horizontalDistance)
        ) {
            best = { token, distance, horizontalDistance };
        }
    }

    return best?.token ?? null;
}

function shouldParsePastedMarkdown(text: string): boolean {
    return (
        text.includes("\n") ||
        parseMarkdownFragment(text).blocks.some((block) => block.type !== "paragraph" || block.text !== text)
    );
}

function replaceSingleLineBlockStartWithPastedMarkdown(block: HTMLElement, text: string, after: string): boolean {
    const combinedText = text + after;
    const parsedBlocks = parseMarkdownFragment(combinedText).blocks;
    const parsedBlock = parsedBlocks.length === 1 ? parsedBlocks[0] : null;

    if (!parsedBlock || (parsedBlock.type === "paragraph" && parsedBlock.text === combinedText)) {
        return false;
    }

    const nextBlock = createBlock(parsedBlock.type, parsedBlock.text, parsedBlock);

    block.replaceWith(nextBlock);
    syncFirstBlockPlaceholder();
    focusBlockAtOffset(nextBlock, Math.max(0, getBlockText(nextBlock).length - after.length));
    return true;
}

function replaceBlockWithPastedMarkdown(block: HTMLElement, text: string, after = ""): void {
    const parsedBlocks = parseMarkdownFragment(text).blocks;
    const focusTarget = appendTextAfterParsedPaste(parsedBlocks, after);
    const nextBlocks = parsedBlocks.map((parsedBlock) => createBlock(parsedBlock.type, parsedBlock.text, parsedBlock));
    const focusBlock = nextBlocks[focusTarget.blockIndex];

    block.replaceWith(...nextBlocks);
    syncFirstBlockPlaceholder();
    focusBlockAtOffset(focusBlock, focusTarget.offset);
}

function insertParsedPastedBlocksAfter(block: HTMLElement, text: string, after: string): void {
    const parsedBlocks = parseMarkdownFragment(text).blocks;
    const focusTarget = appendTextAfterParsedPaste(parsedBlocks, after);
    const nextBlocks = parsedBlocks.map((parsedBlock) => createBlock(parsedBlock.type, parsedBlock.text, parsedBlock));
    const focusBlock = nextBlocks[focusTarget.blockIndex];

    block.after(...nextBlocks);
    syncFirstBlockPlaceholder();
    focusBlockAtOffset(focusBlock, focusTarget.offset);
}

function appendTextAfterParsedPaste(blocks: ParsedBlock[], after: string): { blockIndex: number; offset: number } {
    const lastBlockIndex = Math.max(0, blocks.length - 1);
    const lastBlock = blocks[lastBlockIndex];
    const focusOffset = lastBlock.text.length;

    if (!after) {
        return { blockIndex: lastBlockIndex, offset: focusOffset };
    }

    if (canAppendTextToParsedPasteBlock(lastBlock)) {
        lastBlock.text += after;
        return { blockIndex: lastBlockIndex, offset: focusOffset };
    }

    blocks.push({ type: "paragraph", text: after });
    return { blockIndex: blocks.length - 1, offset: 0 };
}

function canAppendTextToParsedPasteBlock(block: ParsedBlock): boolean {
    return isInlineMarkdownBlockType(block.type);
}

function getOnlyInactiveImageToken(block: HTMLElement): HTMLElement | null {
    const content = getBlockContent(block);
    const tokens = Array.from(content.children).filter(
        (child): child is HTMLElement =>
            child instanceof HTMLElement && child.classList.contains("markdown-image-token"),
    );
    const token = tokens.length === 1 ? tokens[0] : null;

    if (!token || token.dataset.active === "true") {
        return null;
    }

    return getMarkdownText(content).trim() === getMarkdownText(token).trim() ? token : null;
}
