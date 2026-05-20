import {
    clearBlockProperties,
    createBlock,
    getBlockContent,
    getBlockText,
    getSiblingBlock,
    isIndentableListBlockType,
    isMultilinePlainTextBlockType,
    isRichTextBlockType,
    readBlockIndent,
    readBlockListMarker,
    readBlockQuoteLevel,
    readNextListNumber,
    readSplitContinuationType,
    setBlockIndent,
    setBlockText,
    shouldResetEmptyBlock,
    syncFirstBlockPlaceholder,
} from "./view";
import { readBlockType, type ParsedBlock } from "./model";
import {
    focusBlock,
    focusBlockAtOffset,
    getCaretOffset,
    getCurrentBlockOffset,
    getSelectedBlockRange,
    isCaretAtBlockEdge,
} from "../selection/caret";
import {
    deleteSelectedContent,
    insertTextAtCaret,
} from "../selection/commands";

type BlockOperationHooks = {
    parseFragment?: (content: string) => { blocks: ParsedBlock[] };
};

let hooks: BlockOperationHooks = {
    parseFragment: parsePlainTextFragment,
};

export function configureBlockOperations(nextHooks: BlockOperationHooks): void {
    hooks = { ...hooks, ...nextHooks };
}

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

export function removeTrailingLineBreakInMultilinePlainTextBlock(block: HTMLElement): boolean {
    if (!isMultilinePlainTextBlockType(readBlockType(block.dataset.type))) {
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

export function insertPastedText(block: HTMLElement, text: string): void {
    const selectedBlock = deleteSelectedContent() ?? block;

    if (isMultilinePlainTextBlockType(readBlockType(selectedBlock.dataset.type))) {
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

    if (isWholeBlockPaste && shouldParsePastedContent(text)) {
        replaceBlockWithPastedContent(selectedBlock, text);
        return;
    }

    const lines = text.split("\n");

    if (before === "" && lines.length > 1) {
        replaceBlockWithPastedContent(selectedBlock, text, after);
        return;
    }

    if (lines.length === 1) {
        if (before === "" && replaceSingleLineBlockStartWithPastedContent(selectedBlock, text, after)) {
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

    if (type === "source") {
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

function shouldParsePastedContent(text: string): boolean {
    return (
        text.includes("\n") ||
        parsePastedFragment(text).blocks.some((block) => block.type !== "paragraph" || block.text !== text)
    );
}

function replaceSingleLineBlockStartWithPastedContent(block: HTMLElement, text: string, after: string): boolean {
    const combinedText = text + after;
    const parsedBlocks = parsePastedFragment(combinedText).blocks;
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

function replaceBlockWithPastedContent(block: HTMLElement, text: string, after = ""): void {
    const parsedBlocks = parsePastedFragment(text).blocks;
    const focusTarget = appendTextAfterParsedPaste(parsedBlocks, after);
    const nextBlocks = parsedBlocks.map((parsedBlock) => createBlock(parsedBlock.type, parsedBlock.text, parsedBlock));
    const focusBlock = nextBlocks[focusTarget.blockIndex];

    block.replaceWith(...nextBlocks);
    syncFirstBlockPlaceholder();
    focusBlockAtOffset(focusBlock, focusTarget.offset);
}

function insertParsedPastedBlocksAfter(block: HTMLElement, text: string, after: string): void {
    const parsedBlocks = parsePastedFragment(text).blocks;
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
    return isRichTextBlockType(block.type);
}

function parsePastedFragment(text: string): { blocks: ParsedBlock[] } {
    return hooks.parseFragment?.(text) ?? parsePlainTextFragment(text);
}

function parsePlainTextFragment(content: string): { blocks: ParsedBlock[] } {
    const blocks = content
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((text): ParsedBlock => ({ type: "paragraph", text }));

    return { blocks: blocks.length > 0 ? blocks : [{ type: "paragraph", text: "" }] };
}
