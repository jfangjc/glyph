import { type ParsedBlock, readBlockType } from "../../../editor/blocks/model";
import { getBlockSourceElement } from "../../../editor/blocks/rendering";
import {
    ensureEditableBlockAfter,
    getBlockContent,
    getBlockText,
    getSiblingBlock,
    setBlockIndent,
    setBlockListMarker,
    setBlockListNumber,
    setBlockText,
    setBlockType,
    setCodeFence,
    setCodeInfo,
} from "../../../editor/blocks/view";
import {
    focusBlock,
    focusBlockAtOffset,
    focusPlainTextElement,
    getCollapsedSelectionRect,
    getCurrentBlockOffset,
    isCaretAtBlockEdge,
    readLineHeight,
} from "../../../editor/selection/caret";
import { caretSpacerCharacter, getRenderedContentText } from "../../../editor/selection/rendered-content-dom";
import { insertTextAtCaret } from "../../../editor/selection/commands";
import { parseMarkdownReferenceDefinition } from "../references";
import { markdownShortcuts } from "../shortcuts";
import { readSingleLineMarkdownHtmlBlock } from "../html";
import { createMarkdownTableFromHeader } from "../table";

export function startCodeBlockFromFence(block: HTMLElement): boolean {
    if (readBlockType(block.dataset.type) !== "paragraph" || !isCaretAtBlockEdge(block, "end")) {
        return false;
    }

    const match = getBlockText(block).match(/^(`{3,}|~{3,})(.*)$/);
    if (!match) {
        return false;
    }

    setBlockType(block, "code");
    setCodeFence(block, match[1]);
    setCodeInfo(block, match[2].trim());
    setBlockText(block, "");
    ensureEditableBlockAfter(block);
    focusBlockAtOffset(block, 0);
    return true;
}

export function startTableFromHeader(block: HTMLElement): boolean {
    if (readBlockType(block.dataset.type) !== "paragraph" || !isCaretAtBlockEdge(block, "end")) {
        return false;
    }

    const table = createMarkdownTableFromHeader(getBlockText(block));
    if (!table) {
        return false;
    }

    setBlockType(block, "table");
    setBlockText(block, table.text);
    block.dataset.blockSourceActive = "true";

    const source = getBlockSourceElement(getBlockContent(block), "atomic");
    if (source) {
        focusPlainTextElement(source, table.firstBodyCellOffset);
    } else {
        focusBlockAtOffset(block, table.firstBodyCellOffset);
    }

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

export function applyMarkdownShortcut(block: HTMLElement): boolean {
    if (readBlockType(block.dataset.type) !== "paragraph") {
        return false;
    }

    const text = getBlockText(block);
    const referenceDefinition = parseMarkdownReferenceDefinition(text);
    if (referenceDefinition) {
        setBlockType(block, "reference");
        setBlockText(block, text);
        ensureEditableBlockAfter(block);
        focusBlock(block);
        return true;
    }

    const htmlBlock = readSingleLineMarkdownHtmlBlock(text);
    if (htmlBlock) {
        setBlockType(block, "html");
        setBlockText(block, htmlBlock.text);
        ensureEditableBlockAfter(block);
        focusHtmlBlockSource(block);
        return true;
    }

    const orderedListShortcut = readOrderedListShortcut(text);
    if (orderedListShortcut) {
        setBlockType(block, "ordered-list");
        setBlockIndent(block, orderedListShortcut.indent);
        setBlockListNumber(block, orderedListShortcut.listNumber);
        setBlockText(block, orderedListShortcut.text);
        ensureEmptyShortcutCaretAnchor(block, orderedListShortcut.text);
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
    const shortcutText = text.slice(shortcut.marker.length);
    setBlockText(block, shortcutText);
    ensureEmptyShortcutCaretAnchor(block, shortcutText);
    ensureEditableBlockAfter(block);

    if (shortcut.type === "rule") {
        const nextBlock = getSiblingBlock(block, "next");
        focusBlockAtOffset(nextBlock ?? block, 0);
        return true;
    }

    if (shortcut.type === "math") {
        const source = getBlockSourceElement(getBlockContent(block), "atomic");
        if (source) {
            focusPlainTextElement(source, readMathShortcutCaretOffset(source));
            return true;
        }
    }

    focusBlock(block);
    return true;
}

function readOrderedListShortcut(text: string): { indent: number; listNumber: string; text: string } | null {
    const match = text.match(/^([ \t]*)(\d{1,9})\.\s+(.*)$/);
    if (!match) {
        return null;
    }

    return {
        indent: readShortcutIndent(match[1]),
        listNumber: match[2],
        text: match[3],
    };
}

function readShortcutIndent(value: string): number {
    let columns = 0;

    for (let index = 0; index < value.length; index += 1) {
        columns += value[index] === "\t" ? 4 - (columns % 4) : 1;
    }

    return Math.min(Math.max(Math.floor(columns / 2), 0), 3);
}

function ensureEmptyShortcutCaretAnchor(block: HTMLElement, text: string): void {
    const type = readBlockType(block.dataset.type);
    if (text !== "" || type === "rule" || type === "math") {
        return;
    }

    getBlockContent(block).append(document.createTextNode(caretSpacerCharacter));
}

function readMathShortcutCaretOffset(source: HTMLElement): number {
    const text = source.textContent ?? "";
    const openingDelimiterEnd = text.indexOf("\n");
    return openingDelimiterEnd >= 0 ? openingDelimiterEnd + 1 : text.length;
}

function focusHtmlBlockSource(block: HTMLElement): void {
    const source = getBlockSourceElement(getBlockContent(block), "atomic");
    if (!source) {
        focusBlock(block);
        return;
    }

    block.dataset.blockSourceActive = "true";
    focusPlainTextElement(source, source.textContent?.length ?? 0);
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
        block.dataset.blockSourceActive = "true";
        const suffix = getBlockSourceElement(getBlockContent(block), "suffix");
        if (suffix) {
            focusPlainTextElement(
                suffix,
                Math.min(rawOffset - completedCodeBlock.closingLineStart, completedCodeBlock.closingLineLength),
            );
            return;
        }
    }

    delete block.dataset.blockSourceActive;
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

    return getRenderedContentText(content).trim() === getRenderedContentText(token).trim() ? token : null;
}
