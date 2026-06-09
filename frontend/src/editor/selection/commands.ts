import {
    canMergeBlockText,
    createBlock,
    getBlockContent,
    getBlockText,
    isRichTextBlockType,
    readBlockEditingKind,
    readEditorBlock,
    setBlockText,
    setBlockType,
} from "../blocks/view";
import { readBlockType } from "../blocks/model";
import {
    focusBlockAtOffset,
    getCaretOffset,
    getSelectedBlockRange,
    type SelectedBlockRange,
} from "./caret";
import type { ParsedBlock } from "../blocks/model";
import type { InlineFormat } from "../../app/keymap";

export type SelectionInsertionTarget = {
    block: HTMLElement;
    offset: number;
};

export function readSelectedContent(serializeBlocks: (blocks: ParsedBlock[]) => string): string | null {
    const selectedRange = getSelectedBlockRange();
    if (!selectedRange) {
        return null;
    }

    const selectedBlocks = selectedRange.blocks.map((block) => readSelectedEditorBlock(block, selectedRange));
    const content = serializeBlocks(selectedBlocks);

    return content.endsWith("\n") ? content.slice(0, -1) : content;
}

export function deleteSelectedContent(): SelectionInsertionTarget | null {
    const selectedRange = getSelectedBlockRange();
    if (!selectedRange) {
        return null;
    }

    const { blocks, startBlock, endBlock, startOffset, endOffset } = selectedRange;
    const startText = getBlockText(startBlock);
    const endText = getBlockText(endBlock);

    if (startBlock === endBlock) {
        setBlockText(startBlock, startText.slice(0, startOffset) + startText.slice(endOffset));
        focusBlockAtOffset(startBlock, startOffset);
        return { block: startBlock, offset: startOffset };
    }

    if (canMergeSelectedBlockRange(selectedRange)) {
        setBlockText(startBlock, startText.slice(0, startOffset) + endText.slice(endOffset));

        for (const block of blocks.slice(1)) {
            block.remove();
        }

        if (getBlockText(startBlock) === "") {
            setBlockType(startBlock, "paragraph");
        }

        focusBlockAtOffset(startBlock, startOffset);
        return { block: startBlock, offset: startOffset };
    }

    return replaceSelectedBlockRangeWithRemainders(selectedRange);
}

export function replaceSelectionWithText(block: HTMLElement, text: string): void {
    const target = deleteSelectedContent() ?? {
        block,
        offset: getCurrentSelectionOffset(block),
    };
    insertTextAtCaret(target.block, text);
}

export function applyInlineFormatShortcut(block: HTMLElement, format: InlineFormat): boolean {
    const marker = format === "bold" ? "**" : "*";
    const selectedRange = getSelectedBlockRange();

    if (!selectedRange) {
        return insertInlineFormatPair(block, marker);
    }

    return toggleInlineFormatForSelection(selectedRange, marker);
}

export function insertTextAtCaret(block: HTMLElement, text: string): void {
    const content = getBlockContent(block);
    const selection = document.getSelection();
    const selectedText = getBlockText(block);
    const offset = selection?.focusNode
        ? getCaretOffset(content, selection.focusNode, selection.focusOffset)
        : selectedText.length;

    setBlockText(block, selectedText.slice(0, offset) + text + selectedText.slice(offset));
    focusBlockAtOffset(block, offset + text.length);
}

function readSelectedEditorBlock(block: HTMLElement, selectedRange: SelectedBlockRange): ParsedBlock {
    const text = getBlockText(block);
    const startOffset = block === selectedRange.startBlock ? selectedRange.startOffset : 0;
    const endOffset = block === selectedRange.endBlock ? selectedRange.endOffset : text.length;

    if (startOffset === 0 && endOffset === text.length) {
        return readEditorBlock(block);
    }

    return { type: "paragraph", text: text.slice(startOffset, endOffset) };
}

function canMergeSelectedBlockRange(selectedRange: SelectedBlockRange): boolean {
    return (
        selectedRange.blocks.every((block) => isRichTextBlockType(readBlockType(block.dataset.type))) &&
        canMergeBlockText(readBlockType(selectedRange.startBlock.dataset.type), readBlockType(selectedRange.endBlock.dataset.type))
    );
}

function replaceSelectedBlockRangeWithRemainders(selectedRange: SelectedBlockRange): SelectionInsertionTarget {
    const { blocks, startBlock, endBlock, startOffset, endOffset } = selectedRange;
    const startPrefix = getBlockText(startBlock).slice(0, startOffset);
    const endSuffix = getBlockText(endBlock).slice(endOffset);
    const remainders: ParsedBlock[] = [];
    const startRemainder = readRemainderBlock(startBlock, startPrefix);
    const endRemainder = readRemainderBlock(endBlock, endSuffix);

    if (startRemainder) {
        remainders.push(startRemainder);
    }

    if (endRemainder) {
        remainders.push(endRemainder);
    }

    if (remainders.length === 0) {
        remainders.push({ type: "paragraph", text: "" });
    }

    const replacementBlocks = remainders.map((block) => createBlock(block.type, block.text, block));
    startBlock.replaceWith(...replacementBlocks);
    for (const block of blocks.slice(1)) {
        block.remove();
    }

    const focusBlock = replacementBlocks[0];
    const focusOffset = startRemainder ? getBlockText(focusBlock).length : 0;
    focusBlockAtOffset(focusBlock, focusOffset);
    return { block: focusBlock, offset: focusOffset };
}

function readRemainderBlock(block: HTMLElement, text: string): ParsedBlock | null {
    if (text !== "") {
        return readPartialEditorBlock(block, text);
    }

    return null;
}

function readPartialEditorBlock(block: HTMLElement, text: string): ParsedBlock {
    const parsedBlock = readEditorBlock(block);
    const type = readBlockType(block.dataset.type);
    const nextBlock: ParsedBlock = { ...parsedBlock, text };

    if (type === "math") {
        delete nextBlock.mathSource;
    }

    if (readBlockEditingKind(type) === "atomic") {
        return { type: "paragraph", text };
    }

    return nextBlock;
}

function getCurrentSelectionOffset(block: HTMLElement): number {
    const content = getBlockContent(block);
    const selection = document.getSelection();
    return selection?.focusNode ? getCaretOffset(content, selection.focusNode, selection.focusOffset) : getBlockText(block).length;
}

function insertInlineFormatPair(block: HTMLElement, marker: string): boolean {
    if (!isRichTextBlockType(readBlockType(block.dataset.type))) {
        return false;
    }

    const content = getBlockContent(block);
    const selection = document.getSelection();
    const text = getBlockText(block);
    const offset = selection?.focusNode
        ? getCaretOffset(content, selection.focusNode, selection.focusOffset)
        : text.length;

    setBlockText(block, text.slice(0, offset) + marker + marker + text.slice(offset));
    focusBlockAtOffset(block, offset + marker.length);
    return true;
}

function toggleInlineFormatForSelection(selectedRange: SelectedBlockRange, marker: string): boolean {
    let changed = false;
    let focusTarget: { block: HTMLElement; offset: number } | null = null;

    for (const block of selectedRange.blocks) {
        if (!isRichTextBlockType(readBlockType(block.dataset.type))) {
            continue;
        }

        const text = getBlockText(block);
        const start = block === selectedRange.startBlock ? selectedRange.startOffset : 0;
        const end = block === selectedRange.endBlock ? selectedRange.endOffset : text.length;
        const update = toggleInlineFormatInText(text, start, end, marker);

        if (!update) {
            continue;
        }

        setBlockText(block, update.text);
        changed = true;
        focusTarget = { block, offset: update.focusOffset };
    }

    if (focusTarget) {
        focusBlockAtOffset(focusTarget.block, focusTarget.offset);
    }

    return changed;
}

function toggleInlineFormatInText(
    text: string,
    start: number,
    end: number,
    marker: string,
): { text: string; focusOffset: number } | null {
    if (start === end) {
        return null;
    }

    const selectedText = text.slice(start, end);
    if (selectedText.startsWith(marker) && selectedText.endsWith(marker) && selectedText.length >= marker.length * 2) {
        return {
            text:
                text.slice(0, start) +
                selectedText.slice(marker.length, selectedText.length - marker.length) +
                text.slice(end),
            focusOffset: end - marker.length * 2,
        };
    }

    if (text.slice(start - marker.length, start) === marker && text.slice(end, end + marker.length) === marker) {
        return {
            text: text.slice(0, start - marker.length) + selectedText + text.slice(end + marker.length),
            focusOffset: end - marker.length,
        };
    }

    return {
        text: text.slice(0, start) + marker + selectedText + marker + text.slice(end),
        focusOffset: end + marker.length * 2,
    };
}
