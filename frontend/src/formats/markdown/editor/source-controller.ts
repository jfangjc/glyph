import { parseMarkdownFragment } from "../parse";
import {
    applyBlockProperties,
    createBlock,
    ensureEditableBlockAfter,
    findBlock,
    getBlockContent,
    getBlockText,
    getSiblingBlock,
    readBlockIndent,
    setBlockText,
} from "../../../editor/blocks/view";
import { readBlockType, type ParsedBlock } from "../../../editor/blocks/model";
import {
    deleteBlockBoundary,
    indentListBlocks,
    splitBlock,
    type BlockBoundaryDeleteResult,
} from "../../../editor/blocks/operations";
import {
    getBlockSourceElement,
    isBlockSourceElement,
    readBlockSourcePosition,
    type BlockSourcePosition,
} from "../../../editor/blocks/rendering";
import {
    focusBlockAtOffset,
    focusPlainTextElement,
    getCaretOffset,
    getCurrentBlockOffset,
    getPlainTextBoundaryOffset,
    isCaretAtBlockEdge,
} from "../../../editor/selection/caret";
import { readInlineFormatShortcut } from "../../../editor/input/keyboard-shortcuts";
import { getRenderedContentText } from "../../../editor/selection/rendered-content-dom";
import { hasMarkdownBlockSource } from "../block-source";
import { formatMarkdownTableSource } from "../table";
import { readMathSourceText } from "../math";
import { serializeListIndent } from "../utils";
import { clearPendingMarkdownTokenNavigation } from "./token-controller";
import {
    getCodeBlockRawMarkdown,
    isValidCodeBlockSource,
    readCodeBlockSourceParts,
    serializeInvalidCodeBlockSource,
} from "./source-code";
import {
    createEmptyTableRow,
    isEditableTableSource,
    readTableCellBoundary,
    readTableColumnCount,
    readTableRowCellBoundaries,
    type TableCellBoundary,
} from "./source-table";

type MarkdownSourceHooks = {
    markEditorDirty?: () => void;
    syncBlockMarkdownSourceReveal?: (block: HTMLElement | null) => void;
};

let hooks: MarkdownSourceHooks = {};
let activeBlockMarkdownSource: { block: HTMLElement; rawBeforeActivation: string } | null = null;

export function configureMarkdownSourceController(nextHooks: MarkdownSourceHooks): void {
    hooks = { ...hooks, ...nextHooks };
}

export function handleBlockMarkdownSourceKeydown(event: KeyboardEvent): boolean {
    const source = getFocusedBlockMarkdownSource();
    if (!source) {
        return false;
    }

    clearPendingMarkdownTokenNavigation();

    if (event.key === "Tab" && indentListBlockFromSource(event, source)) {
        event.preventDefault();
        hooks.markEditorDirty?.();
        return true;
    }

    const sourceBoundaryDelete = event.key === "Backspace" ? removeOrMergeBackwardFromSourceStart(source) : null;
    if (sourceBoundaryDelete) {
        event.preventDefault();
        if (sourceBoundaryDelete === "changed") {
            hooks.markEditorDirty?.();
        }
        return true;
    }

    if (event.key === "Delete" && removeFollowingEmptyParagraphFromCodeSuffix(source)) {
        event.preventDefault();
        hooks.markEditorDirty?.();
        return true;
    }

    if (
        (event.key === "Backspace" && isCaretAtPlainTextEdge(source, "start")) ||
        (event.key === "Delete" && isCaretAtPlainTextEdge(source, "end"))
    ) {
        event.preventDefault();
        return true;
    }

    if (deleteLastBlockMarkdownSourceCharacter(event, source)) {
        event.preventDefault();
        hooks.markEditorDirty?.();
        return true;
    }

    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && moveAfterSourcePreview(source)) {
        event.preventDefault();
        hooks.markEditorDirty?.();
        return true;
    }

    if (event.key === "Tab" && moveInTableSource(event, source, event.shiftKey ? "previous-cell" : "next-cell")) {
        event.preventDefault();
        hooks.markEditorDirty?.();
        return true;
    }

    if (event.key === "Enter" && insertLineBreakInTableSource(event, source)) {
        event.preventDefault();
        hooks.markEditorDirty?.();
        return true;
    }

    if (event.key === "Enter" && moveCaretAfterCodeBlockSource(source)) {
        event.preventDefault();
        hooks.markEditorDirty?.();
        return true;
    }

    if (event.key === "Enter" && splitAfterBlockMarkdownSource(source)) {
        event.preventDefault();
        hooks.markEditorDirty?.();
        return true;
    }

    if (event.key === "Enter" || readInlineFormatShortcut(event)) {
        event.preventDefault();
    }

    return true;
}

function indentListBlockFromSource(event: KeyboardEvent, source: HTMLElement): boolean {
    const block = findBlock(source);
    const type = readBlockType(block?.dataset.type);

    if (!block || (type !== "list" && type !== "ordered-list" && type !== "todo")) {
        return false;
    }

    return indentListBlocks(block, event.shiftKey ? -1 : 1);
}

type TableSourceFocus = {
    lineIndex: number;
    cellIndex: number;
    cellOffset: number;
} | null;

function insertLineBreakInTableSource(event: KeyboardEvent, source: HTMLElement): boolean {
    const block = findBlock(source);
    if (
        !block ||
        readBlockType(block.dataset.type) !== "table" ||
        readBlockSourcePosition(source) !== "atomic" ||
        event.ctrlKey ||
        event.metaKey
    ) {
        return false;
    }

    const currentText = source.textContent ?? "";
    const currentCell = readCurrentTableCell(source);
    const columnCount = readTableColumnCount(currentText);
    if (!currentCell || columnCount < 2) {
        return false;
    }

    if (isCaretAfterFinalTablePipe(source)) {
        moveAfterTableSource(source);
        return true;
    }

    moveToTableCell(source, currentCell.lineIndex + 1, 0, true);
    return true;
}

function moveInTableSource(
    event: KeyboardEvent,
    source: HTMLElement,
    direction: "previous-cell" | "next-cell",
): boolean {
    const block = findBlock(source);
    if (
        !block ||
        readBlockType(block.dataset.type) !== "table" ||
        readBlockSourcePosition(source) !== "atomic" ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
    ) {
        return false;
    }

    const currentCell = readCurrentTableCell(source);
    if (!currentCell) {
        return false;
    }

    const text = source.textContent ?? "";
    const columnCount = readTableColumnCount(text);
    if (columnCount < 2) {
        return false;
    }

    const nextCellIndex = currentCell.cellIndex + (direction === "next-cell" ? 1 : -1);
    if (nextCellIndex >= 0 && nextCellIndex < columnCount) {
        moveToTableCell(source, currentCell.lineIndex, nextCellIndex, false);
        return true;
    }

    const nextLineIndex = currentCell.lineIndex + (direction === "next-cell" ? 1 : -1);
    if (nextLineIndex < 2) {
        return true;
    }

    moveToTableCell(source, nextLineIndex, direction === "next-cell" ? 0 : columnCount - 1, direction === "next-cell");
    return true;
}

function moveAfterSourcePreview(source: HTMLElement): boolean {
    const block = findBlock(source);
    if (!block || readBlockSourcePosition(source) !== "atomic") {
        return false;
    }

    const type = readBlockType(block.dataset.type);
    if (type !== "table" && type !== "definition-list" && type !== "math" && type !== "html") {
        return false;
    }

    applyFocusedBlockMarkdownSourceInput(source);
    ensureEditableBlockAfter(block);
    focusBlockAtOffset(getSiblingBlock(block, "next") ?? block, 0);
    return true;
}

function moveAfterTableSource(source: HTMLElement): boolean {
    const block = findBlock(source);
    if (!block) {
        return false;
    }

    if (readBlockType(block.dataset.type) !== "table" || readBlockSourcePosition(source) !== "atomic") {
        return false;
    }

    applyFocusedBlockMarkdownSourceInput(source);
    ensureEditableBlockAfter(block);
    focusBlockAtOffset(getSiblingBlock(block, "next") ?? block, 0);
    return true;
}

function moveToTableCell(source: HTMLElement, lineIndex: number, cellIndex: number, appendRows: boolean): void {
    let text = source.textContent ?? "";
    const columnCount = readTableColumnCount(text);
    if (columnCount < 2) {
        return;
    }

    if (appendRows) {
        const row = createEmptyTableRow(columnCount);
        let lines = text.split("\n");
        while (lineIndex >= lines.length) {
            lines.push(row);
        }
        text = formatMarkdownTableSource(lines.join("\n"));
        source.textContent = text;
    }

    const targetCell = readTableCellBoundary(text, lineIndex, cellIndex);
    if (!targetCell) {
        return;
    }

    focusPlainTextElement(source, targetCell.start);
    applyFocusedBlockMarkdownSourceInput(source);
}

function readCurrentTableCell(source: HTMLElement): TableCellBoundary | null {
    const text = source.textContent ?? "";
    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    const offset =
        selection?.isCollapsed && focusNode && (focusNode === source || source.contains(focusNode))
            ? getPlainTextBoundaryOffset(source, focusNode, selection.focusOffset)
            : text.length;

    return readTableCellBoundaryAtOffset(text, offset);
}

function isCaretAfterFinalTablePipe(source: HTMLElement): boolean {
    const text = source.textContent ?? "";
    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    const offset =
        selection?.isCollapsed && focusNode && (focusNode === source || source.contains(focusNode))
            ? getPlainTextBoundaryOffset(source, focusNode, selection.focusOffset)
            : text.length;
    const finalPipeOffset = text.search(/\|\s*$/);

    return finalPipeOffset >= 0 && offset > finalPipeOffset && offset <= text.length;
}

function readTableCellBoundaryAtOffset(text: string, offset: number): TableCellBoundary | null {
    const lines = text.split("\n");
    let lineStart = 0;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        const lineEnd = lineStart + line.length;
        if (offset >= lineStart && offset <= lineEnd) {
            const cells = readTableRowCellBoundaries(line, lineStart, lineIndex);
            return cells.find((cell) => offset <= cell.end) ?? cells[cells.length - 1] ?? null;
        }

        lineStart = lineEnd + 1;
    }

    return null;
}

export function moveCaretIntoCodeBlockSourceAtBoundary(event: KeyboardEvent, block: HTMLElement): boolean {
    if (
        readBlockType(block.dataset.type) !== "code" ||
        (event.key !== "Backspace" && event.key !== "Delete")
    ) {
        return false;
    }

    if (event.key === "Backspace" && isCaretAtBlockEdge(block, "start")) {
        return focusBlockMarkdownSource(block, "prefix", "end");
    }

    if (event.key === "Delete" && isCaretAtBlockEdge(block, "end")) {
        return focusBlockMarkdownSource(block, "suffix", "start");
    }

    return false;
}

export function moveCaretAfterCodeBlockSourceAtSelection(block: HTMLElement): boolean {
    if (readBlockType(block.dataset.type) !== "code" || !isCaretAfterCodeBlockSuffixSource(block)) {
        return false;
    }

    commitActiveBlockMarkdownSource(null);
    ensureEditableBlockAfter(block);
    focusBlockAtOffset(getSiblingBlock(block, "next") ?? block, 0);
    return true;
}

export function trackVerticalBlockSourceNavigation(event: KeyboardEvent, block: HTMLElement): boolean {
    if (
        (event.key !== "ArrowUp" && event.key !== "ArrowDown") ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
    ) {
        return false;
    }

    const direction = event.key === "ArrowUp" ? "previous" : "next";
    const edge = direction === "previous" ? "start" : "end";
    if (!isCaretAtBlockEdge(block, edge)) {
        return false;
    }

    const target = getSiblingBlock(block, direction);
    if (target && hasMarkdownBlockSource(readBlockType(target.dataset.type))) {
        hooks.syncBlockMarkdownSourceReveal?.(target);

        if (direction === "previous" && getBlockText(block) === "") {
            event.preventDefault();
            focusBlockAtOffset(target, getBlockText(target).length, { scroll: "minimal" });
            return true;
        }
    }

    return false;
}

export function getFocusedBlockMarkdownSource(): HTMLElement | null {
    const focusNode = document.getSelection()?.focusNode;
    const focusElement = focusNode instanceof Element ? focusNode : focusNode?.parentElement;

    return focusElement?.closest<HTMLElement>(".format-block-source") ?? null;
}

export function applyFocusedBlockMarkdownSourceInput(
    source: HTMLElement | null = getFocusedBlockMarkdownSource(),
): boolean {
    const block = findBlock(source);
    if (!source || !block) {
        return false;
    }

    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    const sourceOffset =
        selection?.isCollapsed && focusNode && (focusNode === source || source.contains(focusNode))
            ? getPlainTextBoundaryOffset(source, focusNode, selection.focusOffset)
            : (source.textContent ?? "").length;
    const sourcePosition = readBlockSourcePosition(source);
    const rawOffset = getBlockRawMarkdownOffset(block, sourcePosition, sourceOffset);
    const tableFocus = readTableSourceFocus(block, source, sourceOffset);
    const parsedBlock = parseEditedRawMarkdownBlock(block, getBlockRawMarkdown(block));

    applyBlockProperties(block, parsedBlock);
    setBlockText(block, parsedBlock.text);
    if (restoreTableSourceFocusAfterInput(block, tableFocus)) {
        return true;
    }

    restoreFocusAfterBlockMarkdownSourceInput(block, sourcePosition, sourceOffset, rawOffset);
    return true;
}

export function readSelectedBlockMarkdownSourceText(): string | null {
    const range = readSelectedBlockMarkdownSourceRange();
    if (!range) {
        return null;
    }

    return (range.source.textContent ?? "").slice(range.startOffset, range.endOffset);
}

export function deleteSelectedBlockMarkdownSourceText(): boolean {
    const range = readSelectedBlockMarkdownSourceRange();
    if (!range) {
        return false;
    }

    const text = range.source.textContent ?? "";
    range.source.textContent = text.slice(0, range.startOffset) + text.slice(range.endOffset);
    focusPlainTextElement(range.source, range.startOffset);
    applyFocusedBlockMarkdownSourceInput(range.source);
    return true;
}

export function insertTextIntoFocusedBlockMarkdownSource(text: string): boolean {
    const target = readFocusedBlockMarkdownSourceTarget();
    if (!target) {
        return false;
    }

    const currentText = target.source.textContent ?? "";
    target.source.textContent =
        currentText.slice(0, target.startOffset) + text + currentText.slice(target.endOffset);
    focusPlainTextElement(target.source, target.startOffset + text.length);
    applyFocusedBlockMarkdownSourceInput(target.source);
    return true;
}

export function syncActiveBlockMarkdownSource(focusBlock: HTMLElement | null): void {
    const source = getFocusedBlockMarkdownSource();
    const sourceBlock = findBlock(source);

    if (source && sourceBlock) {
        if (activeBlockMarkdownSource?.block !== sourceBlock) {
            activeBlockMarkdownSource = {
                block: sourceBlock,
                rawBeforeActivation: getBlockRawMarkdown(sourceBlock),
            };
        }
        return;
    }

    commitActiveBlockMarkdownSource(focusBlock);
}

export function commitActiveBlockMarkdownSource(
    focusBlock: HTMLElement | null = findBlock(document.getSelection()?.focusNode ?? null),
): void {
    const active = activeBlockMarkdownSource;
    activeBlockMarkdownSource = null;

    if (!active?.block.isConnected) {
        return;
    }

    const rawMarkdown = getBlockRawMarkdown(active.block);
    const shouldNormalizeTable = readBlockType(active.block.dataset.type) === "table";
    if (rawMarkdown === active.rawBeforeActivation && !shouldNormalizeTable) {
        return;
    }

    applyRawMarkdownToBlock(active.block, rawMarkdown, focusBlock, { normalizeTable: shouldNormalizeTable });
}

export function rerenderPlainTextBlockMarkdownSource(block: HTMLElement): boolean {
    if (readBlockType(block.dataset.type) !== "code") {
        return false;
    }

    const offset = getCurrentBlockOffset(block);
    const text = getBlockText(block);

    setBlockText(block, text);
    focusBlockAtOffset(block, Math.min(offset, text.length), { scroll: "none" });
    return true;
}

function deleteLastBlockMarkdownSourceCharacter(event: KeyboardEvent, source: HTMLElement): boolean {
    if (event.key !== "Backspace" && event.key !== "Delete") {
        return false;
    }

    const text = source.textContent ?? "";
    if (text.length !== 1) {
        return false;
    }

    const isDeletingCharacter =
        (event.key === "Backspace" && isCaretAtPlainTextEdge(source, "end")) ||
        (event.key === "Delete" && isCaretAtPlainTextEdge(source, "start"));
    if (!isDeletingCharacter) {
        return false;
    }

    source.textContent = "";
    focusPlainTextElement(source, 0);
    applyFocusedBlockMarkdownSourceInput(source);
    return true;
}

type BlockMarkdownSourceRange = {
    source: HTMLElement;
    startOffset: number;
    endOffset: number;
};

function readFocusedBlockMarkdownSourceTarget(): BlockMarkdownSourceRange | null {
    const selectedRange = readSelectedBlockMarkdownSourceRange();
    if (selectedRange) {
        return selectedRange;
    }

    const source = getFocusedBlockMarkdownSource();
    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    if (!source || !selection?.isCollapsed || !focusNode || (focusNode !== source && !source.contains(focusNode))) {
        return null;
    }

    const offset = getPlainTextBoundaryOffset(source, focusNode, selection.focusOffset);
    return { source, startOffset: offset, endOffset: offset };
}

function readSelectedBlockMarkdownSourceRange(): BlockMarkdownSourceRange | null {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return null;
    }

    const range = selection.getRangeAt(0);
    const startSource = findContainingBlockMarkdownSource(range.startContainer);
    const endSource = findContainingBlockMarkdownSource(range.endContainer);
    if (!startSource || startSource !== endSource) {
        return null;
    }

    const startOffset = getPlainTextBoundaryOffset(startSource, range.startContainer, range.startOffset);
    const endOffset = getPlainTextBoundaryOffset(startSource, range.endContainer, range.endOffset);
    return {
        source: startSource,
        startOffset: Math.min(startOffset, endOffset),
        endOffset: Math.max(startOffset, endOffset),
    };
}

function findContainingBlockMarkdownSource(node: Node): HTMLElement | null {
    const element = node instanceof Element ? node : node.parentElement;
    return element?.closest<HTMLElement>(".format-block-source") ?? null;
}

function removeOrMergeBackwardFromSourceStart(source: HTMLElement): BlockBoundaryDeleteResult | null {
    if (
        !isCaretAtPlainTextEdge(source, "start") ||
        (readBlockSourcePosition(source) !== "prefix" && readBlockSourcePosition(source) !== "atomic")
    ) {
        return null;
    }

    const block = findBlock(source);
    return block ? deleteBlockBoundary(block, "previous") : null;
}

function removeFollowingEmptyParagraphFromCodeSuffix(source: HTMLElement): boolean {
    if (readBlockSourcePosition(source) !== "suffix" || !isCaretAtPlainTextEdge(source, "end")) {
        return false;
    }

    const block = findBlock(source);
    const next = block ? getSiblingBlock(block, "next") : null;
    if (!next || readBlockType(next.dataset.type) !== "paragraph" || getBlockText(next) !== "") {
        return false;
    }

    next.remove();
    return true;
}

function focusBlockMarkdownSource(
    block: HTMLElement,
    position: BlockSourcePosition,
    edge: "start" | "end",
): boolean {
    const source = getBlockSourceElement(getBlockContent(block), position);
    if (!source) {
        return false;
    }

    focusPlainTextElement(source, edge === "start" ? 0 : (source.textContent ?? "").length);
    return true;
}

function splitAfterBlockMarkdownSource(source: HTMLElement): boolean {
    const block = findBlock(source);
    if (!block || readBlockType(block.dataset.type) === "code") {
        return false;
    }

    if (insertParagraphBeforeBlockSourceStart(source, block)) {
        return true;
    }

    commitActiveBlockMarkdownSource(null);

    const type = readBlockType(block.dataset.type);
    if (type === "code") {
        focusBlockAtOffset(block, 0, { scroll: "none" });
        return true;
    }

    if (type === "rule") {
        ensureEditableBlockAfter(block);
        focusBlockAtOffset(getSiblingBlock(block, "next") ?? block, 0);
        return true;
    }

    focusBlockAtOffset(block, getBlockText(block).length, { scroll: "none" });
    splitBlock(block);
    return true;
}

function insertParagraphBeforeBlockSourceStart(source: HTMLElement, block: HTMLElement): boolean {
    if (readBlockSourcePosition(source) !== "prefix" || !isCaretAtPlainTextEdge(source, "start")) {
        return false;
    }

    commitActiveBlockMarkdownSource(null);
    const previousBlock = createBlock("paragraph");
    block.before(previousBlock);
    focusBlockAtOffset(previousBlock, 0, { scroll: "minimal" });
    return true;
}

function moveCaretAfterCodeBlockSource(source: HTMLElement): boolean {
    const block = findBlock(source);
    if (
        !block ||
        readBlockType(block.dataset.type) !== "code" ||
        readBlockSourcePosition(source) !== "suffix" ||
        !isCaretAtPlainTextEdge(source, "end")
    ) {
        return false;
    }

    commitActiveBlockMarkdownSource(null);
    ensureEditableBlockAfter(block);
    focusBlockAtOffset(getSiblingBlock(block, "next") ?? block, 0);
    return true;
}

function isCaretAfterCodeBlockSuffixSource(block: HTMLElement): boolean {
    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    const content = getBlockContent(block);
    const suffix = getBlockSourceElement(content, "suffix");

    if (!selection?.isCollapsed || !focusNode || !suffix) {
        return false;
    }

    if (getFocusedBlockMarkdownSource() === suffix) {
        return isCaretAtPlainTextEdge(suffix, "end");
    }

    if (focusNode !== content) {
        return false;
    }

    const suffixIndex = Array.from(content.childNodes).findIndex((child) => child === suffix);
    return suffixIndex >= 0 && selection.focusOffset > suffixIndex;
}

function isCaretAtPlainTextEdge(element: HTMLElement, edge: "start" | "end"): boolean {
    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    if (!selection?.isCollapsed || !focusNode || (focusNode !== element && !element.contains(focusNode))) {
        return false;
    }

    const offset = getPlainTextBoundaryOffset(element, focusNode, selection.focusOffset);
    return edge === "start" ? offset === 0 : offset === (element.textContent ?? "").length;
}

function readTableSourceFocus(block: HTMLElement, source: HTMLElement, sourceOffset: number): TableSourceFocus {
    if (readBlockType(block.dataset.type) !== "table" || readBlockSourcePosition(source) !== "atomic") {
        return null;
    }

    const cell = readTableCellBoundaryAtOffset(source.textContent ?? "", sourceOffset);
    if (!cell) {
        return null;
    }

    return {
        lineIndex: cell.lineIndex,
        cellIndex: cell.cellIndex,
        cellOffset: Math.max(0, sourceOffset - cell.start),
    };
}

function restoreTableSourceFocusAfterInput(block: HTMLElement, focus: TableSourceFocus): boolean {
    if (!focus || readBlockType(block.dataset.type) !== "table") {
        return false;
    }

    const source = getBlockSourceElement(getBlockContent(block), "atomic");
    const cell = source ? readTableCellBoundary(source.textContent ?? "", focus.lineIndex, focus.cellIndex) : null;
    if (!source || !cell) {
        return false;
    }

    focusPlainTextElement(source, Math.min(cell.start + focus.cellOffset, cell.end));
    activeBlockMarkdownSource = {
        block,
        rawBeforeActivation: getBlockRawMarkdown(block),
    };
    return true;
}

function applyRawMarkdownToBlock(
    block: HTMLElement,
    rawMarkdown: string,
    focusBlock: HTMLElement | null,
    options: { normalizeTable?: boolean } = {},
): void {
    const parsedBlock = parseEditedRawMarkdownBlock(block, rawMarkdown, options);
    const selection = document.getSelection();
    const shouldRestoreFocus = focusBlock === block && selection?.focusNode && !getFocusedBlockMarkdownSource();
    const focusOffset = shouldRestoreFocus
        ? getCaretOffset(getBlockContent(block), selection.focusNode, selection.focusOffset)
        : null;

    applyBlockProperties(block, parsedBlock);
    setBlockText(block, parsedBlock.text);

    if (focusOffset !== null) {
        focusBlockAtOffset(block, Math.min(focusOffset, parsedBlock.text.length), { scroll: "none" });
    }
}

function restoreFocusAfterBlockMarkdownSourceInput(
    block: HTMLElement,
    position: BlockSourcePosition | null,
    sourceOffset: number,
    rawOffset: number,
): void {
    const source = position
        ? getBlockSourceElement(getBlockContent(block), position)
        : null;

    if (source) {
        focusPlainTextElement(source, Math.min(sourceOffset, source.textContent?.length ?? 0));
        activeBlockMarkdownSource = {
            block,
            rawBeforeActivation: getBlockRawMarkdown(block),
        };
        return;
    }

    activeBlockMarkdownSource = null;
    focusBlockAtOffset(block, Math.min(rawOffset, getBlockText(block).length), { scroll: "none" });
}

function getBlockRawMarkdownOffset(
    block: HTMLElement,
    position: BlockSourcePosition | null,
    sourceOffset: number,
): number {
    if (position === "prefix" && isListSourceBlock(block)) {
        return serializeListIndent(readBlockIndent(block)).length + sourceOffset;
    }

    if (position !== "suffix" || readBlockType(block.dataset.type) !== "code") {
        return sourceOffset;
    }

    const source = readCodeBlockSourceParts(block);
    if (!source) {
        return sourceOffset;
    }

    return source.prefix.length + 1 + source.text.length + 1 + sourceOffset;
}

function parseEditedRawMarkdownBlock(
    block: HTMLElement,
    rawMarkdown: string,
    options: { normalizeTable?: boolean } = {},
): ParsedBlock {
    const type = readBlockType(block.dataset.type);

    if (type === "code") {
        const codeSource = readCodeBlockSourceParts(block);
        if (codeSource && !isValidCodeBlockSource(codeSource)) {
            return {
                type: "paragraph",
                text: serializeInvalidCodeBlockSource(codeSource),
            };
        }
    }

    if (type === "table" && isEditableTableSource(rawMarkdown)) {
        return {
            type: "table",
            text: options.normalizeTable ? formatMarkdownTableSource(rawMarkdown) : rawMarkdown,
        };
    }

    if (type === "definition-list") {
        const parsedBlocks = parseMarkdownFragment(rawMarkdown).blocks;
        return parsedBlocks.length === 1 && parsedBlocks[0].type === "definition-list"
            ? parsedBlocks[0]
            : { type: "definition-list", text: rawMarkdown };
    }

    if (type === "math") {
        return {
            type: "math",
            text: readMathSourceText(rawMarkdown),
            mathSource: rawMarkdown,
        };
    }

    if (type === "html") {
        return {
            type: "html",
            text: rawMarkdown,
        };
    }

    const parsedBlocks = parseMarkdownFragment(rawMarkdown).blocks;
    return parsedBlocks.length === 1 ? parsedBlocks[0] : { type: "paragraph", text: rawMarkdown };
}

function getBlockRawMarkdown(block: HTMLElement): string {
    if (readBlockType(block.dataset.type) === "code") {
        return getCodeBlockRawMarkdown(block);
    }

    let text = "";

    for (const child of Array.from(getBlockContent(block).childNodes)) {
        text += isBlockMarkdownSource(child)
            ? getBlockSourceRawMarkdown(block, child)
            : getRenderedContentText(child);
    }

    return text;
}

function getBlockSourceRawMarkdown(block: HTMLElement, source: HTMLElement): string {
    const text = source.textContent ?? "";
    if (readBlockSourcePosition(source) === "prefix" && isListSourceBlock(block)) {
        return `${serializeListIndent(readBlockIndent(block))}${text}`;
    }

    return text;
}

function isListSourceBlock(block: HTMLElement): boolean {
    const type = readBlockType(block.dataset.type);
    return type === "list" || type === "ordered-list" || type === "todo";
}

function isBlockMarkdownSource(node: Node): node is HTMLElement {
    return isBlockSourceElement(node);
}
