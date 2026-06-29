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
import { headingTypes, readBlockType, type ParsedBlock } from "../../../editor/blocks/model";
import {
    deleteBlockBoundary,
    indentListBlocks,
    removeEmptyBlockBackward,
    splitBlock,
    type BlockBoundaryDeleteResult,
} from "../../../editor/blocks/operations";
import {
    getBlockSourceElement,
    isBlockSourceElement,
    isEditableBlockSourceElement,
    readBlockSourcePosition,
    type BlockSourcePosition,
} from "../../../editor/blocks/rendering";
import {
    focusBlockAtOffset,
    focusPlainTextElement,
    getCaretOffset,
    getCaretPositionFromPoint,
    getCurrentBlockOffset,
    getPlainTextBoundaryOffset,
    isCaretAtBlockEdge,
    readCurrentSourceSelectionTarget,
} from "../../../editor/selection/caret";
import { readInlineFormatShortcut } from "../../../app/keymap";
import { getRenderedContentText } from "../../../editor/selection/rendered-content-dom";
import { formatMarkdownTableSource } from "../table";
import { readMathSourceText } from "../math";
import { serializeListIndent } from "../utils";
import { serializeMarkdownBlock } from "../serialize";
import { clearPendingMarkdownTokenNavigation } from "./token-controller";
import {
    getCodeBlockRawMarkdown,
    isValidCodeBlockSource,
    readCodeBlockSourceParts,
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
};

let hooks: MarkdownSourceHooks = {};
type MarkdownSourceDraft = {
    block: HTMLElement;
    kind: "block-source" | "inline-source";
    rawBeforeActivation: string;
    rawDraft: string;
};

let activeBlockMarkdownSource: MarkdownSourceDraft | null = null;

export function configureMarkdownSourceController(nextHooks: MarkdownSourceHooks): void {
    hooks = { ...hooks, ...nextHooks };
}

export function handleBlockMarkdownSourceKeydown(event: KeyboardEvent): boolean {
    const source = getFocusedBlockMarkdownSource();
    if (!source) {
        return false;
    }

    ensureActiveBlockMarkdownSource(source);
    clearPendingMarkdownTokenNavigation();

    if (moveCaretOutOfBlockSourceHorizontally(event, source)) {
        event.preventDefault();
        return true;
    }

    if (event.key === "Tab" && indentListBlockFromSource(event, source)) {
        event.preventDefault();
        hooks.markEditorDirty?.();
        return true;
    }

    const emptyListItemDelete = event.key === "Backspace" ? removeEmptyListItemBackwardFromSource(source) : null;
    if (emptyListItemDelete) {
        event.preventDefault();
        if (emptyListItemDelete === "changed") {
            hooks.markEditorDirty?.();
        }
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

    if (event.key === "Enter" && insertParagraphBeforeHeadingFromPrefix(event, source)) {
        event.preventDefault();
        hooks.markEditorDirty?.();
        return true;
    }

    if (event.key === "Enter" && splitAfterBlockMarkdownSource(source)) {
        event.preventDefault();
        hooks.markEditorDirty?.();
        return true;
    }

    if (event.key === "Enter" || readInlineFormatShortcut(event, "markdown")) {
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

export function deleteHeadingPrefixCharacterAtBoundary(event: KeyboardEvent, block: HTMLElement): boolean {
    if (event.key !== "Backspace" || event.ctrlKey || event.metaKey || event.altKey) {
        return false;
    }

    if (!headingTypes.has(readBlockType(block.dataset.type)) || !isCaretAtBlockEdge(block, "start")) {
        return false;
    }

    const source = getBlockSourceElement(getBlockContent(block), "prefix");
    const text = source?.textContent ?? "";
    if (!source || text === "") {
        return false;
    }

    ensureActiveBlockMarkdownSource(source);
    source.textContent = text.slice(0, -1);
    focusPlainTextElement(source, source.textContent.length);
    applyFocusedBlockMarkdownSourceInput(source);
    return true;
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

export function getFocusedBlockMarkdownSource(): HTMLElement | null {
    const target = readFocusedBlockMarkdownSourceSelection();
    if (target) {
        normalizeFocusedBlockMarkdownSourceSelection(target);
        return target.source;
    }

    return getDirectlyFocusedBlockMarkdownSource();
}

export function getDirectlyFocusedBlockMarkdownSource(): HTMLElement | null {
    const focusNode = document.getSelection()?.focusNode;
    const focusElement = focusNode instanceof Element ? focusNode : focusNode?.parentElement;
    const source = focusElement?.closest<HTMLElement>(".format-block-source") ?? null;
    return source && isEditableBlockSourceElement(source) ? source : null;
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
    const sourceSelection = readFocusedBlockMarkdownSourceSelection();
    const sourceOffset = sourceSelection?.source === source
        ? sourceSelection.sourceOffset
        : selection?.isCollapsed && focusNode && (focusNode === source || source.contains(focusNode))
          ? getPlainTextBoundaryOffset(source, focusNode, selection.focusOffset)
          : (source.textContent ?? "").length;
    const sourcePosition = readBlockSourcePosition(source);
    const rawOffset = getBlockRawMarkdownOffset(block, sourcePosition, sourceOffset);
    const tableFocus = readTableSourceFocus(block, source, sourceOffset);
    const rawMarkdown = getBlockRawMarkdown(block);
    const parsedBlock = tryParseEditableMarkdownBlockSource(
        rawMarkdown,
        readEditableMarkdownBlockSourceParseOptions(block, source),
    );
    const activeDraft = readOrCreateBlockSourceDraft(block);

    activeDraft.rawDraft = rawMarkdown;
    if (!parsedBlock) {
        restoreInvalidBlockMarkdownSourceInput(block, source, sourceOffset);
        return true;
    }

    clearBlockMarkdownSourceDraftState(block);
    if (isListPrefixParagraphDraft(block, source, parsedBlock)) {
        source.dataset.blockSourceDraft = "true";
        focusPlainTextElement(source, Math.min(sourceOffset, source.textContent?.length ?? 0));
        return true;
    }

    applyBlockProperties(block, parsedBlock);
    setBlockText(block, parsedBlock.text);
    if (restoreTableSourceFocusAfterInput(block, tableFocus)) {
        return true;
    }

    restoreFocusAfterBlockMarkdownSourceInput(block, sourcePosition, sourceOffset, rawOffset);
    return true;
}

export function ensureActiveBlockMarkdownSource(
    source: HTMLElement | null = getFocusedBlockMarkdownSource(),
): void {
    const block = findBlock(source);
    if (source && block) {
        readOrCreateBlockSourceDraft(block);
    }
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
    ensureActiveBlockMarkdownSource(range.source);
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
    ensureActiveBlockMarkdownSource(target.source);
    target.source.textContent =
        currentText.slice(0, target.startOffset) + text + currentText.slice(target.endOffset);
    focusPlainTextElement(target.source, target.startOffset + text.length);
    applyFocusedBlockMarkdownSourceInput(target.source);
    return true;
}

export function deletePrefixBlockMarkdownSourceCharacter(source: HTMLElement): boolean {
    if (readBlockSourcePosition(source) !== "prefix" || !isEditableBlockSourceElement(source)) {
        return false;
    }

    const text = source.textContent ?? "";
    if (text === "") {
        return false;
    }

    ensureActiveBlockMarkdownSource(source);
    source.textContent = text.slice(0, -1);
    focusPlainTextElement(source, Math.max(0, text.length - 1));
    applyFocusedBlockMarkdownSourceInput(source);
    return true;
}

export function handleBlockMarkdownSourceClick(event: MouseEvent): boolean {
    const source = readClickedBlockMarkdownSource(event);
    const selection = document.getSelection();
    if (!source || !selection?.isCollapsed) {
        return false;
    }

    ensureActiveBlockMarkdownSource(source);
    focusPlainTextElement(source, readBlockMarkdownSourcePointerOffset(source, event.clientX, event.clientY));
    return true;
}

function readClickedBlockMarkdownSource(event: MouseEvent): HTMLElement | null {
    const target = event.target;
    if (!(target instanceof Element)) {
        return null;
    }

    const directSource = target.closest<HTMLElement>(".format-block-source");
    if (directSource && isEditableBlockSourceElement(directSource)) {
        return directSource;
    }

    const block = findBlock(target);
    if (!block || block.dataset.blockSourceActive !== "true") {
        return null;
    }

    const source = getBlockSourceElement(getBlockContent(block), "prefix");
    if (!source || !isEditableBlockSourceElement(source)) {
        return null;
    }

    const rect = source.getBoundingClientRect();
    const slop = 2;
    if (
        event.clientX < rect.left - slop ||
        event.clientX > rect.right + slop ||
        event.clientY < rect.top - slop ||
        event.clientY > rect.bottom + slop
    ) {
        return null;
    }

    return source;
}

export function syncActiveBlockMarkdownSource(
    focusBlock: HTMLElement | null,
    source: HTMLElement | null = getFocusedBlockMarkdownSource(),
): void {
    const sourceBlock = findBlock(source);

    if (source && sourceBlock) {
        if (activeBlockMarkdownSource?.block !== sourceBlock) {
            const rawMarkdown = getBlockRawMarkdown(sourceBlock);
            activeBlockMarkdownSource = {
                block: sourceBlock,
                kind: "block-source",
                rawBeforeActivation: rawMarkdown,
                rawDraft: rawMarkdown,
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
    const parsedRawMarkdown = tryParseEditableMarkdownBlockSource(
        rawMarkdown,
        readEditableMarkdownBlockSourceParseOptions(active.block),
    );
    const shouldNormalizeTable = readBlockType(active.block.dataset.type) === "table";
    if (parsedRawMarkdown && rawMarkdown === active.rawBeforeActivation && !shouldNormalizeTable) {
        clearBlockMarkdownSourceDraftState(active.block);
        return;
    }

    clearBlockMarkdownSourceDraftState(active.block);
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

    ensureActiveBlockMarkdownSource(source);
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
    const sourceSelection = readFocusedBlockMarkdownSourceSelection();
    if (source && sourceSelection?.source === source) {
        return {
            source,
            startOffset: sourceSelection.sourceOffset,
            endOffset: sourceSelection.sourceOffset,
        };
    }

    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    if (!source || !selection?.isCollapsed || !focusNode || (focusNode !== source && !source.contains(focusNode))) {
        return null;
    }

    const offset = getPlainTextBoundaryOffset(source, focusNode, selection.focusOffset);
    return { source, startOffset: offset, endOffset: offset };
}

function readBlockMarkdownSourcePointerOffset(source: HTMLElement, clientX: number, clientY: number): number {
    const position = getCaretPositionFromPoint(clientX, clientY);
    if (position && (position.node === source || source.contains(position.node))) {
        return getPlainTextBoundaryOffset(source, position.node, position.offset);
    }

    return readPlainTextOffsetFromCharacterRects(source, clientX, clientY) ?? (source.textContent ?? "").length;
}

function readPlainTextOffsetFromCharacterRects(source: HTMLElement, clientX: number, clientY: number): number | null {
    const range = document.createRange();
    const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
    let textOffset = 0;
    let lineFallback: number | null = null;
    let node: Node | null;

    while ((node = walker.nextNode())) {
        const text = node.textContent ?? "";
        for (let index = 0; index < text.length; index += 1) {
            range.setStart(node, index);
            range.setEnd(node, index + 1);
            const rect = Array.from(range.getClientRects()).find((candidate) => candidate.width > 0 || candidate.height > 0);
            if (!rect) {
                continue;
            }

            const isSameLine = clientY >= rect.top - 2 && clientY <= rect.bottom + 2;
            if (isSameLine) {
                lineFallback = textOffset + index + 1;
                if (clientX < rect.left) {
                    range.detach();
                    return textOffset + index;
                }

                if (clientX <= rect.right) {
                    range.detach();
                    return textOffset + index + (clientX > rect.left + rect.width / 2 ? 1 : 0);
                }
            }
        }

        textOffset += text.length;
    }

    range.detach();
    return lineFallback;
}

function readSelectedBlockMarkdownSourceRange(): BlockMarkdownSourceRange | null {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return null;
    }

    const range = selection.getRangeAt(0);
    const startBoundary = readSelectedBlockMarkdownSourceBoundary(
        range.startContainer,
        range.startOffset,
        "start",
    );
    const endBoundary = readSelectedBlockMarkdownSourceBoundary(range.endContainer, range.endOffset, "end");
    if (!startBoundary || !endBoundary || startBoundary.source !== endBoundary.source) {
        return null;
    }

    return {
        source: startBoundary.source,
        startOffset: Math.min(startBoundary.offset, endBoundary.offset),
        endOffset: Math.max(startBoundary.offset, endBoundary.offset),
    };
}

function readSelectedBlockMarkdownSourceBoundary(
    node: Node,
    offset: number,
    edge: "start" | "end",
): { source: HTMLElement; offset: number } | null {
    const containingSource = findContainingBlockMarkdownSource(node);
    if (containingSource) {
        return {
            source: containingSource,
            offset: getPlainTextBoundaryOffset(containingSource, node, offset),
        };
    }

    const adjacentSource = findAdjacentSelectedBlockMarkdownSource(node, offset, edge);
    if (!adjacentSource) {
        return null;
    }

    return {
        source: adjacentSource,
        offset: edge === "start" ? 0 : adjacentSource.textContent?.length ?? 0,
    };
}

function findContainingBlockMarkdownSource(node: Node | null): HTMLElement | null {
    if (!node) {
        return null;
    }

    const element = node instanceof Element ? node : node.parentElement;
    const source = element?.closest<HTMLElement>(".format-block-source") ?? null;
    return source && isEditableBlockSourceElement(source) ? source : null;
}

function findAdjacentSelectedBlockMarkdownSource(
    node: Node,
    offset: number,
    edge: "start" | "end",
): HTMLElement | null {
    const adjacent = readSelectedRangeAdjacentNode(node, offset, edge);
    const source = adjacent && isBlockSourceElement(adjacent) ? adjacent : findContainingBlockMarkdownSource(adjacent);
    return source && isEditableBlockSourceElement(source) ? source : null;
}

function readSelectedRangeAdjacentNode(node: Node, offset: number, edge: "start" | "end"): Node | null {
    if (node.nodeType === Node.TEXT_NODE) {
        const textLength = node.textContent?.length ?? 0;
        if (edge === "start" && offset >= textLength) {
            return skipEmptyBoundaryText(node.nextSibling, "next");
        }

        if (edge === "end" && offset <= 0) {
            return skipEmptyBoundaryText(node.previousSibling, "previous");
        }

        return null;
    }

    if (!(node instanceof HTMLElement)) {
        return null;
    }

    const children = Array.from(node.childNodes);
    const adjacent = edge === "start" ? children[offset] : children[offset - 1];
    return skipEmptyBoundaryText(adjacent ?? null, edge === "start" ? "next" : "previous");
}

function skipEmptyBoundaryText(node: Node | null, direction: "next" | "previous"): Node | null {
    let current = node;
    while (current?.nodeType === Node.TEXT_NODE && current.textContent === "") {
        current = direction === "next" ? current.nextSibling : current.previousSibling;
    }

    return current;
}

function removeEmptyListItemBackwardFromSource(source: HTMLElement): BlockBoundaryDeleteResult | null {
    if (
        readBlockSourcePosition(source) !== "prefix" ||
        (!isCaretAtPlainTextEdge(source, "start") && !isCaretAtPlainTextEdge(source, "end"))
    ) {
        return null;
    }

    const block = findBlock(source);
    if (
        !block ||
        (source.textContent ?? "") !== "" ||
        getBlockText(block) !== "" ||
        !isListItemBlockType(readBlockType(block.dataset.type))
    ) {
        return null;
    }

    return removeEmptyBlockBackward(block);
}

function isListItemBlockType(type: ReturnType<typeof readBlockType>): boolean {
    return type === "list" || type === "ordered-list" || type === "todo";
}

function moveCaretOutOfBlockSourceHorizontally(event: KeyboardEvent, source: HTMLElement): boolean {
    if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
    ) {
        return false;
    }

    const block = findBlock(source);
    const position = readBlockSourcePosition(source);
    if (!block || !position) {
        return false;
    }

    if (event.key === "ArrowRight" && position === "prefix" && isCaretAtPlainTextEdge(source, "end")) {
        focusBlockAtOffset(block, 0, { scroll: "none" });
        return true;
    }

    if (event.key === "ArrowLeft" && position === "suffix" && isCaretAtPlainTextEdge(source, "start")) {
        focusBlockAtOffset(block, getBlockText(block).length, { scroll: "none" });
        return true;
    }

    return false;
}

function removeOrMergeBackwardFromSourceStart(source: HTMLElement): BlockBoundaryDeleteResult | null {
    if (
        !isCaretAtPlainTextEdge(source, "start") ||
        (readBlockSourcePosition(source) !== "prefix" && readBlockSourcePosition(source) !== "atomic")
    ) {
        return null;
    }

    const block = findBlock(source);
    if (!block) {
        return null;
    }

    if (readBlockSourcePosition(source) === "prefix" && headingTypes.has(readBlockType(block.dataset.type))) {
        const previous = getSiblingBlock(block, "previous");
        if (previous) {
            if (readBlockType(previous.dataset.type) === "paragraph" && getBlockText(previous) === "") {
                previous.remove();
                focusPlainTextElement(source, 0);
                return "changed";
            }

            if (readBlockType(previous.dataset.type) === "paragraph") {
                const previousText = getBlockText(previous);
                if (previousText !== "") {
                    const focusOffset = previousText.length;
                    setBlockText(previous, previousText + getBlockRawMarkdown(block));
                    block.remove();
                    focusBlockAtOffset(previous, focusOffset, { scroll: "minimal" });
                    return "changed";
                }
            }

            focusBlockAtOffset(previous, getBlockText(previous).length, { scroll: "minimal" });
        }

        return "moved";
    }

    return deleteBlockBoundary(block, "previous");
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

function insertParagraphBeforeHeadingFromPrefix(event: KeyboardEvent, source: HTMLElement): boolean {
    const block = findBlock(source);
    if (
        !block ||
        event.ctrlKey ||
        event.metaKey ||
        readBlockSourcePosition(source) !== "prefix" ||
        !headingTypes.has(readBlockType(block.dataset.type))
    ) {
        return false;
    }

    const sourceOffset = getFocusedSourceOffset(source);
    const sourceText = source.textContent ?? "";
    if (sourceOffset > 0 && getBlockText(block) !== "") {
        splitHeadingTextAfterPrefix(block, sourceText);
        return true;
    }

    const previousBlock = createBlock("paragraph");
    block.before(previousBlock);
    focusPlainTextElement(source, sourceOffset);
    return true;
}

function splitHeadingTextAfterPrefix(block: HTMLElement, sourceText: string): void {
    const text = getBlockText(block);
    const nextBlock = createBlock("paragraph", text);

    activeBlockMarkdownSource = null;
    applyBlockProperties(block, { type: "paragraph" });
    setBlockText(block, sourceText);
    block.after(nextBlock);
    focusBlockAtOffset(nextBlock, 0, { scroll: "minimal" });
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
    const sourceSelection = readFocusedBlockMarkdownSourceSelection();
    if (sourceSelection?.source === element) {
        return edge === "start"
            ? sourceSelection.sourceOffset === 0
            : sourceSelection.sourceOffset === (element.textContent ?? "").length;
    }

    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    if (!selection?.isCollapsed || !focusNode || (focusNode !== element && !element.contains(focusNode))) {
        return false;
    }

    const offset = getPlainTextBoundaryOffset(element, focusNode, selection.focusOffset);
    return edge === "start" ? offset === 0 : offset === (element.textContent ?? "").length;
}

function getFocusedSourceOffset(source: HTMLElement): number {
    const sourceSelection = readFocusedBlockMarkdownSourceSelection();
    if (sourceSelection?.source === source) {
        return sourceSelection.sourceOffset;
    }

    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    return selection?.isCollapsed && focusNode && (focusNode === source || source.contains(focusNode))
        ? getPlainTextBoundaryOffset(source, focusNode, selection.focusOffset)
        : 0;
}

function readFocusedBlockMarkdownSourceSelection(): {
    source: HTMLElement;
    sourceOffset: number;
} | null {
    const target = readCurrentSourceSelectionTarget();
    return target?.kind === "block-source"
        ? {
              source: target.source,
              sourceOffset: target.sourceOffset,
          }
        : null;
}

function normalizeFocusedBlockMarkdownSourceSelection(target: { source: HTMLElement; sourceOffset: number }): void {
    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    if (!selection?.isCollapsed || !focusNode || focusNode === target.source || target.source.contains(focusNode)) {
        return;
    }

    focusPlainTextElement(target.source, target.sourceOffset);
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
    const rawMarkdown = getBlockRawMarkdown(block);
    activeBlockMarkdownSource = {
        block,
        kind: "block-source",
        rawBeforeActivation: activeBlockMarkdownSource?.block === block
            ? activeBlockMarkdownSource.rawBeforeActivation
            : rawMarkdown,
        rawDraft: rawMarkdown,
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
    applyParsedMarkdownBlockToBlock(block, parsedBlock, focusBlock);
}

function applyParsedMarkdownBlockToBlock(
    block: HTMLElement,
    parsedBlock: ParsedBlock,
    focusBlock: HTMLElement | null,
): void {
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
        const rawMarkdown = getBlockRawMarkdown(block);
        activeBlockMarkdownSource = {
            block,
            kind: "block-source",
            rawBeforeActivation: activeBlockMarkdownSource?.block === block
                ? activeBlockMarkdownSource.rawBeforeActivation
                : rawMarkdown,
            rawDraft: rawMarkdown,
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
                text: rawMarkdown,
            };
        }
    }

    if (type === "table") {
        return {
            type: "table",
            text: options.normalizeTable && isEditableTableSource(rawMarkdown)
                ? formatMarkdownTableSource(rawMarkdown)
                : rawMarkdown,
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
    if (readBlockSourcePosition(source) === "prefix" && text.trim() === "") {
        return "";
    }

    if (readBlockSourcePosition(source) === "prefix" && isListSourceBlock(block)) {
        return `${serializeListIndent(readBlockIndent(block))}${text}`;
    }

    return text;
}

type EditableMarkdownBlockSourceParseOptions = {
    allowParagraph?: boolean;
};

function readEditableMarkdownBlockSourceParseOptions(
    block: HTMLElement,
    source?: HTMLElement | null,
): EditableMarkdownBlockSourceParseOptions {
    return {
        allowParagraph:
            isListPrefixMarkdownSource(block, source) || isEmptyNonListMarkdownBlockSource(block, source),
    };
}

function isListPrefixMarkdownSource(block: HTMLElement, source?: HTMLElement | null): boolean {
    const prefixSource = source ?? getBlockSourceElement(getBlockContent(block), "prefix");
    return Boolean(prefixSource && readBlockSourcePosition(prefixSource) === "prefix" && isListSourceBlock(block));
}

function isEmptyNonListMarkdownBlockSource(block: HTMLElement, source?: HTMLElement | null): boolean {
    if (isListSourceBlock(block)) {
        return false;
    }

    const editableSource =
        source ??
        getBlockSourceElement(getBlockContent(block), "prefix") ??
        getBlockSourceElement(getBlockContent(block), "atomic");
    return Boolean(
        editableSource &&
            readBlockSourcePosition(editableSource) !== "suffix" &&
            isEmptyEditableMarkdownSource(editableSource),
    );
}

function isListPrefixParagraphDraft(block: HTMLElement, source: HTMLElement, parsedBlock: ParsedBlock): boolean {
    return (
        parsedBlock.type === "paragraph" &&
        isListPrefixMarkdownSource(block, source) &&
        !isEmptyEditableMarkdownSource(source)
    );
}

function isEmptyEditableMarkdownSource(source: HTMLElement): boolean {
    return (source.textContent ?? "").trim() === "";
}

function readOrCreateBlockSourceDraft(block: HTMLElement): MarkdownSourceDraft {
    if (activeBlockMarkdownSource?.block === block) {
        return activeBlockMarkdownSource;
    }

    const rawMarkdown = getBlockRawMarkdown(block);
    activeBlockMarkdownSource = {
        block,
        kind: "block-source",
        rawBeforeActivation: rawMarkdown,
        rawDraft: rawMarkdown,
    };
    return activeBlockMarkdownSource;
}

function restoreInvalidBlockMarkdownSourceInput(block: HTMLElement, source: HTMLElement, sourceOffset: number): void {
    source.dataset.blockSourceDraft = "true";
    focusPlainTextElement(source, Math.min(sourceOffset, source.textContent?.length ?? 0));
    const draft = readOrCreateBlockSourceDraft(block);
    draft.rawDraft = getBlockRawMarkdown(block);
}

function clearBlockMarkdownSourceDraftState(block: HTMLElement): void {
    for (const source of Array.from(getBlockContent(block).querySelectorAll<HTMLElement>(".format-block-source"))) {
        delete source.dataset.blockSourceDraft;
    }
}

export function tryParseSingleMarkdownBlockSource(
    rawMarkdown: string,
    options: EditableMarkdownBlockSourceParseOptions = {},
): ParsedBlock | null {
    const parsedBlocks = parseMarkdownFragment(rawMarkdown).blocks;
    if (parsedBlocks.length !== 1) {
        return null;
    }

    const parsedBlock = parsedBlocks[0];
    if (!isMarkdownSourceBlock(parsedBlock) && !(options.allowParagraph && parsedBlock.type === "paragraph")) {
        return null;
    }

    return normalizeRawMarkdownSource(rawMarkdown) === normalizeRawMarkdownSource(serializeMarkdownBlock(parsedBlock))
        ? parsedBlock
        : null;
}

function tryParseEditableMarkdownBlockSource(
    rawMarkdown: string,
    options: EditableMarkdownBlockSourceParseOptions = {},
): ParsedBlock | null {
    if (rawMarkdown === "") {
        return { type: "paragraph", text: "" };
    }

    return tryParseSingleMarkdownBlockSource(rawMarkdown, options);
}

function normalizeRawMarkdownSource(value: string): string {
    return value.replace(/\r\n?/g, "\n").replace(/\n$/, "");
}

function isMarkdownSourceBlock(block: ParsedBlock): boolean {
    return (
        headingTypes.has(block.type) ||
        block.type === "list" ||
        block.type === "ordered-list" ||
        block.type === "todo" ||
        block.type === "quote" ||
        block.type === "code" ||
        block.type === "rule" ||
        block.type === "table" ||
        block.type === "math" ||
        block.type === "html" ||
        block.type === "definition-list"
    );
}

function isListSourceBlock(block: HTMLElement): boolean {
    const type = readBlockType(block.dataset.type);
    return type === "list" || type === "ordered-list" || type === "todo";
}

function isBlockMarkdownSource(node: Node): node is HTMLElement {
    return isBlockSourceElement(node);
}
