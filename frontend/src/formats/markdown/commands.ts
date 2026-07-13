import { findSourceBlockAtOffset, readVisibleListPrefixLength, type Change, type EditorState, type SourceBlock, type Transaction } from "../../editor/core/types";
import {
    nextGraphemeBoundary,
    nextLineBoundary,
    nextWordBoundary,
    previousGraphemeBoundary,
    previousLineBoundary,
    previousWordBoundary,
} from "../../utils/text-boundaries";
import {
    createEmptyMarkdownTableRow,
    formatMarkdownTableSource,
    readMarkdownTableCellAtOffset,
    readMarkdownTableCellFocusOffset,
    readMarkdownTableColumnCount,
} from "./table";

export type DeleteDirection = "backward" | "forward";
export type DeleteGranularity = "grapheme" | "word" | "soft-line" | "hard-line";

export function createInsertTextTransaction(state: EditorState, text: string): Transaction {
    const normalizedText = normalizeInsertedText(text);
    return createCodeBodyReplaceTransaction(state, normalizedText, "input", "typing")
        ?? createReplaceSelectionTransaction(state, normalizedText, "input", "typing");
}

export function createPasteTransaction(state: EditorState, text: string): Transaction {
    const normalizedText = normalizeInsertedText(text);
    return createCodeBodyReplaceTransaction(state, normalizedText, "paste", "discrete")
        ?? createReplaceSelectionTransaction(state, normalizedText, "paste");
}

export function createEnterTransaction(state: EditorState, options: { shiftKey?: boolean } = {}): Transaction {
    const range = orderedSelection(state);
    if (range.from !== range.to) {
        return createCodeBodyReplaceTransaction(state, "\n", "input")
            ?? createReplaceSelectionTransaction(state, "\n", "input");
    }

    const block = findSourceBlockAtOffset(state.blocks, range.from);
    if (block?.type === "table" && options.shiftKey) {
        return createTableExitTransaction(state, block, true);
    }

    const codeExit = block ? createCodeExitTransaction(state, block, range.from) : null;
    if (codeExit) {
        return codeExit;
    }

    const tableEnter = block ? createTableEnterTransaction(state, block, range.from) : null;
    if (tableEnter) {
        return tableEnter;
    }

    if (block && canExitEmptyContinuationBlock(block) && range.from === block.contentFrom) {
        return {
            changes: [{ from: block.sourceFrom, to: block.sourceTo, insert: "" }],
            selection: { anchor: block.sourceFrom, head: block.sourceFrom },
            annotations: { userEvent: "input" },
        };
    }

    const continuation = block ? readLineContinuationPrefix(block) : "";
    if (block && continuation && range.from >= block.contentFrom && range.from <= block.contentTo) {
        const insert = `\n${continuation}`;
        const head = range.from + insert.length;
        return {
            changes: [{ from: range.from, to: range.from, insert }],
            selection: { anchor: head, head },
            annotations: { userEvent: "input" },
        };
    }

    return createCodeBodyReplaceTransaction(state, "\n", "input")
        ?? createReplaceSelectionTransaction(state, "\n", "input");
}

export function createTableTabTransaction(state: EditorState, delta: -1 | 1): Transaction | null {
    const range = orderedSelection(state);
    if (range.from !== range.to) {
        return null;
    }

    const block = findSourceBlockAtOffset(state.blocks, range.from);
    if (!block || block.type !== "table" || range.from < block.sourceFrom || range.from > block.sourceTo) {
        return null;
    }

    const source = state.doc.slice(block.sourceFrom, block.sourceTo);
    const currentCell = readMarkdownTableCellAtOffset(source, range.from - block.sourceFrom);
    const columnCount = readMarkdownTableColumnCount(source);
    if (!currentCell || columnCount < 2) {
        return null;
    }

    let targetLineIndex = currentCell.lineIndex;
    let targetCellIndex = currentCell.cellIndex + delta;
    if (targetCellIndex >= columnCount) {
        targetCellIndex = 0;
        targetLineIndex = currentCell.lineIndex === 0 ? 2 : currentCell.lineIndex + 1;
    } else if (targetCellIndex < 0) {
        targetCellIndex = columnCount - 1;
        targetLineIndex = currentCell.lineIndex === 2 ? 0 : currentCell.lineIndex - 1;
    }

    if (targetLineIndex < 0) {
        return createSelectionTransaction(range.from);
    }

    const lines = source.split("\n");
    const emptyRow = createEmptyMarkdownTableRow(columnCount);
    while (targetLineIndex >= lines.length) {
        lines.push(emptyRow);
    }

    const formatted = formatMarkdownTableSource(lines.join("\n"));
    const targetOffset = readMarkdownTableCellFocusOffset(formatted, targetLineIndex, targetCellIndex);
    if (targetOffset === null) {
        return null;
    }

    const head = block.sourceFrom + targetOffset;
    if (formatted === source) {
        return createSelectionTransaction(head);
    }

    return {
        changes: [{ from: block.sourceFrom, to: block.sourceTo, insert: formatted }],
        selection: { anchor: head, head },
        annotations: { userEvent: "input" },
    };
}

function createTableEnterTransaction(state: EditorState, block: SourceBlock, offset: number): Transaction | null {
    if (block.type !== "table" || offset < block.sourceFrom || offset > block.sourceTo) {
        return null;
    }

    const source = state.doc.slice(block.sourceFrom, block.sourceTo);
    const lines = source.split("\n");
    const localOffset = offset - block.sourceFrom;
    const finalPipeOffset = source.search(/\|\s*$/);
    if (lines.length > 2 && finalPipeOffset >= 0 && localOffset > finalPipeOffset) {
        return createTableExitTransaction(state, block, false);
    }

    const currentCell = readMarkdownTableCellAtOffset(source, localOffset);
    const columnCount = readMarkdownTableColumnCount(source);
    if (!currentCell || columnCount < 2) {
        return null;
    }

    const targetLineIndex = currentCell.lineIndex + 1;
    const emptyRow = createEmptyMarkdownTableRow(columnCount);
    while (targetLineIndex >= lines.length) {
        lines.push(emptyRow);
    }

    const formatted = formatMarkdownTableSource(lines.join("\n"));
    const targetOffset = readMarkdownTableCellFocusOffset(formatted, targetLineIndex, 0);
    if (targetOffset === null) {
        return null;
    }

    const head = block.sourceFrom + targetOffset;
    return {
        changes: [{ from: block.sourceFrom, to: block.sourceTo, insert: formatted }],
        selection: { anchor: head, head },
        annotations: { userEvent: "input" },
    };
}

function createTableExitTransaction(state: EditorState, block: SourceBlock, createParagraph: boolean): Transaction {
    if (createParagraph) {
        const head = block.sourceTo + 1;
        return {
            changes: [{ from: block.sourceTo, to: block.sourceTo, insert: "\n" }],
            selection: { anchor: head, head },
            annotations: { userEvent: "input" },
        };
    }

    const separatorLength = state.doc.startsWith("\r\n", block.sourceTo)
        ? 2
        : state.doc[block.sourceTo] === "\n" ? 1 : 0;
    if (separatorLength > 0) {
        return createSelectionTransaction(block.sourceTo + separatorLength);
    }

    const head = block.sourceTo + 1;
    return {
        changes: [{ from: block.sourceTo, to: block.sourceTo, insert: "\n" }],
        selection: { anchor: head, head },
        annotations: { userEvent: "input" },
    };
}

export function createIndentListTransaction(state: EditorState, delta: number): Transaction | null {
    const step = delta > 0 ? 1 : delta < 0 ? -1 : 0;
    if (step === 0) {
        return null;
    }

    const blocks = readSelectedListBlocks(state);
    const changes = blocks
        .map((block) => createIndentListBlockChange(state.doc, block, step))
        .filter((change): change is Change => change !== null);

    if (changes.length === 0) {
        return null;
    }

    return {
        changes,
        annotations: { userEvent: "input" },
    };
}

function createCodeExitTransaction(state: EditorState, block: SourceBlock, offset: number): Transaction | null {
    if (block.type !== "code" || offset <= block.contentTo || offset > block.sourceTo) {
        return null;
    }

    if (state.doc[block.sourceTo] === "\n") {
        const head = block.sourceTo + 1;
        return createSelectionTransaction(head);
    }

    const head = block.sourceTo + 1;
    return {
        changes: [{ from: block.sourceTo, to: block.sourceTo, insert: "\n" }],
        selection: { anchor: head, head },
        annotations: { userEvent: "input" },
    };
}

export function createIndentCodeTransaction(state: EditorState, delta: number): Transaction | null {
    const step = delta > 0 ? 1 : delta < 0 ? -1 : 0;
    if (step === 0) {
        return null;
    }

    const range = orderedSelection(state);
    const block = state.blocks.blocks.find((candidate) => (
        candidate.type === "code" &&
        range.from >= candidate.contentFrom &&
        range.to <= candidate.contentTo
    ));
    if (!block) {
        return null;
    }

    if (range.from === range.to && step > 0) {
        return {
            changes: [{ from: range.from, to: range.from, insert: "    " }],
            annotations: { userEvent: "input" },
        };
    }

    const lineStarts = readTouchedCodeLineStarts(state.doc, block, range);
    const changes = step > 0
        ? lineStarts.map((from): Change => ({ from, to: from, insert: "    " }))
        : lineStarts
            .map((from) => createCodeOutdentChange(state.doc, from))
            .filter((change): change is Change => change !== null);

    if (changes.length === 0) {
        return {
            changes: [],
            selection: state.selection,
            annotations: { userEvent: "programmatic", addToHistory: false },
        };
    }

    return {
        changes,
        annotations: { userEvent: "input" },
    };
}

export function createDeleteBackwardTransaction(state: EditorState): Transaction | null {
    return createDeleteTransaction(state, "backward", "grapheme");
}

export function createDeleteForwardTransaction(state: EditorState): Transaction | null {
    return createDeleteTransaction(state, "forward", "grapheme");
}

export function createDeleteTransaction(
    state: EditorState,
    direction: DeleteDirection,
    granularity: DeleteGranularity,
): Transaction | null {
    const range = orderedSelection(state);
    if (range.from !== range.to) {
        return createDeleteRangeTransaction(range.from, range.to, "delete");
    }

    const offset = range.from;
    if (direction === "backward" && offset <= 0 || direction === "forward" && offset >= state.doc.length) {
        return null;
    }

    const codeBoundaryNavigation = createCodeBoundaryNavigationTransaction(state, offset, direction);
    if (codeBoundaryNavigation) {
        return codeBoundaryNavigation;
    }

    if (direction === "backward") {
        const hiddenIndentRange = readHiddenListIndentRange(state, offset);
        if (hiddenIndentRange && offset > hiddenIndentRange.from && offset <= hiddenIndentRange.to) {
            return null;
        }

        const resetRange = readResetBlockPrefixRange(state, offset);
        if (resetRange) {
            return createDeleteRangeTransaction(resetRange.from, resetRange.to, "delete");
        }
    }

    const boundary = readDeleteBoundary(state.doc, offset, direction, granularity);
    return direction === "backward"
        ? createDeleteRangeTransaction(boundary, offset, "delete", "typing")
        : createDeleteRangeTransaction(offset, boundary, "delete", "typing");
}

export function createCheckboxToggleTransaction(state: EditorState, blockId: string): Transaction | null {
    const block = state.blocks.blocks.find((candidate) => candidate.id === blockId);
    if (!block || block.type !== "todo") {
        return null;
    }

    const markerOffset = findTodoMarkerOffset(state.doc, block);
    if (markerOffset < 0) {
        return null;
    }

    const checked = state.doc[markerOffset].toLowerCase() === "x";
    return {
        changes: [{ from: markerOffset, to: markerOffset + 1, insert: checked ? " " : "x" }],
        selection: state.selection,
        annotations: { userEvent: "format" },
    };
}

export function createInlineFormatTransaction(state: EditorState, marker: "*" | "**"): Transaction | null {
    const range = orderedSelection(state);
    if (range.from === range.to) {
        const block = findSourceBlockAtOffset(state.blocks, range.from);
        if (block && !isRichMarkdownBlock(block.type)) {
            return null;
        }
        return {
            changes: [{ from: range.from, to: range.to, insert: marker + marker }],
            selection: { anchor: range.from + marker.length, head: range.from + marker.length },
            annotations: { userEvent: "format" },
        };
    }

    const segments = readFormattableSegments(state, range);
    if (segments.length === 0) {
        return null;
    }

    const removeFormatting = segments.every((segment) => readFormatRemoval(state.doc, segment, marker) !== null);
    const changes = segments.flatMap((segment): Change[] => {
        const removal = readFormatRemoval(state.doc, segment, marker);
        if (removeFormatting && removal) {
            return removal;
        }
        if (removal) {
            return [];
        }
        return [
            { from: segment.from, to: segment.from, insert: marker },
            { from: segment.to, to: segment.to, insert: marker },
        ];
    });

    const delta = changes.reduce((total, change) => total + change.insert.length - (change.to - change.from), 0);
    const forward = state.selection.anchor <= state.selection.head;
    const nextFrom = Math.max(0, range.from + Math.min(0, delta));
    const nextTo = Math.max(nextFrom, range.to + delta);

    return {
        changes,
        selection: forward ? { anchor: nextFrom, head: nextTo } : { anchor: nextTo, head: nextFrom },
        annotations: { userEvent: "format" },
    };
}

function readFormattableSegments(
    state: EditorState,
    range: { from: number; to: number },
): Array<{ from: number; to: number }> {
    return state.blocks.blocks
        .filter((block) => isRichMarkdownBlock(block.type))
        .map((block) => ({
            from: Math.max(range.from, block.contentFrom),
            to: Math.min(range.to, block.contentTo),
        }))
        .filter((segment) => segment.from < segment.to && state.doc.slice(segment.from, segment.to).trim() !== "");
}

function readFormatRemoval(
    doc: string,
    segment: { from: number; to: number },
    marker: "*" | "**",
): Change[] | null {
    const selected = doc.slice(segment.from, segment.to);
    if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length >= marker.length * 2) {
        return [
            { from: segment.from, to: segment.from + marker.length, insert: "" },
            { from: segment.to - marker.length, to: segment.to, insert: "" },
        ];
    }

    if (
        doc.slice(Math.max(0, segment.from - marker.length), segment.from) === marker &&
        doc.slice(segment.to, segment.to + marker.length) === marker
    ) {
        return [
            { from: segment.from - marker.length, to: segment.from, insert: "" },
            { from: segment.to, to: segment.to + marker.length, insert: "" },
        ];
    }

    return null;
}

function isRichMarkdownBlock(type: SourceBlock["type"]): boolean {
    return (
        type === "paragraph" ||
        type === "quote" ||
        type === "list" ||
        type === "ordered-list" ||
        type === "todo" ||
        type.startsWith("heading-")
    );
}

export function readSelectedSourceText(state: EditorState): string | null {
    const range = expandCompleteCodeBodySelection(state, orderedSelection(state));
    if (range.from === range.to) {
        return null;
    }

    return state.doc.slice(range.from, range.to);
}

export function createCutTransaction(state: EditorState): Transaction | null {
    const range = expandCompleteCodeBodySelection(state, orderedSelection(state));
    if (range.from === range.to) {
        return null;
    }

    return createDeleteRangeTransaction(range.from, range.to, "delete");
}

function expandCompleteCodeBodySelection(
    state: EditorState,
    range: { from: number; to: number },
): { from: number; to: number } {
    const block = state.blocks.blocks.find((candidate) => (
        candidate.type === "code" &&
        range.from === candidate.contentFrom &&
        range.to === candidate.contentTo
    ));

    return block ? { from: block.sourceFrom, to: block.sourceTo } : range;
}

function createCodeBodyReplaceTransaction(
    state: EditorState,
    text: string,
    userEvent: NonNullable<Transaction["annotations"]>["userEvent"],
    historyMode?: NonNullable<Transaction["annotations"]>["historyMode"],
): Transaction | null {
    const range = orderedSelection(state);
    const block = state.blocks.blocks.find((candidate) => (
        candidate.type === "code" &&
        range.from >= candidate.contentFrom &&
        range.to <= candidate.contentTo
    ));
    const openingFence = block?.codeFence;
    if (!block || !openingFence || !/^(`{3,}|~{3,})$/.test(openingFence)) {
        return null;
    }

    const closingMarker = readClosingFenceMarker(state.doc, block, openingFence[0]);
    if (!closingMarker) {
        return null;
    }

    const needsClosingSeparator = needsEmptyCodeClosingSeparator(state.doc, block, range, closingMarker);
    const body = state.doc.slice(block.contentFrom, block.contentTo);
    const localFrom = range.from - block.contentFrom;
    const localTo = range.to - block.contentFrom;
    const prospectiveBody = body.slice(0, localFrom) + text + body.slice(localTo);
    const longestConflict = readLongestClosingFenceRun(prospectiveBody, openingFence[0]);
    const needsLongerFence = longestConflict >= openingFence.length;
    if (!needsLongerFence && !needsClosingSeparator) {
        return null;
    }

    const changes: Change[] = [{
        from: range.from,
        to: range.to,
        insert: `${text}${needsClosingSeparator ? "\n" : ""}`,
    }];
    let openingDelta = 0;
    if (needsLongerFence) {
        const nextFence = openingFence[0].repeat(longestConflict + 1);
        const openingMarker = readOpeningFenceMarker(state.doc, block, openingFence[0]);
        if (!openingMarker) {
            return null;
        }

        changes.unshift({ from: openingMarker.from, to: openingMarker.to, insert: nextFence });
        if (closingMarker && closingMarker.to - closingMarker.from < nextFence.length) {
            changes.push({ from: closingMarker.from, to: closingMarker.to, insert: nextFence });
        }
        openingDelta = nextFence.length - (openingMarker.to - openingMarker.from);
    }

    const head = range.from + openingDelta + text.length;
    return {
        changes,
        selection: { anchor: head, head },
        annotations: { userEvent, historyMode },
    };
}

function needsEmptyCodeClosingSeparator(
    doc: string,
    block: SourceBlock,
    range: { from: number; to: number },
    closingMarker: { from: number; to: number } | null,
): boolean {
    return (
        Boolean(closingMarker) &&
        block.contentFrom === block.contentTo &&
        range.from === block.contentFrom &&
        range.to === block.contentTo &&
        !/^(\r?\n)/.test(doc.slice(block.contentTo, block.sourceTo))
    );
}

function readLongestClosingFenceRun(text: string, fenceCharacter: string): number {
    let longest = 0;
    const escapedCharacter = fenceCharacter === "`" ? "`" : "~";
    const closingLine = new RegExp(`^ {0,3}(${escapedCharacter}+)[ \\t]*$`);
    for (const line of text.split("\n")) {
        const marker = line.match(closingLine)?.[1];
        if (marker) {
            longest = Math.max(longest, marker.length);
        }
    }
    return longest;
}

function normalizeInsertedText(text: string): string {
    return text.replace(/\r\n?/g, "\n");
}

function readOpeningFenceMarker(
    doc: string,
    block: SourceBlock,
    fenceCharacter: string,
): { from: number; to: number } | null {
    const prefix = doc.slice(block.sourceFrom, block.contentFrom);
    const match = prefix.match(/^[ \t]*([`~]+)/);
    if (!match || match[1][0] !== fenceCharacter) {
        return null;
    }

    const markerFrom = block.sourceFrom + (match[0].length - match[1].length);
    return { from: markerFrom, to: markerFrom + match[1].length };
}

function readClosingFenceMarker(
    doc: string,
    block: SourceBlock,
    fenceCharacter: string,
): { from: number; to: number } | null {
    const suffix = doc.slice(block.contentTo, block.sourceTo);
    const lineBreak = suffix.match(/^(\r?\n)/)?.[1];
    const sharesOpeningLineEnding = block.contentFrom === block.contentTo &&
        /(\r?\n)$/.test(doc.slice(block.sourceFrom, block.contentFrom));
    if (!lineBreak && !sharesOpeningLineEnding) {
        return null;
    }

    const closingLine = suffix.slice(lineBreak?.length ?? 0);
    const match = closingLine.match(/^[ \t]*([`~]+)[ \t]*$/);
    if (!match || match[1][0] !== fenceCharacter) {
        return null;
    }

    const markerFrom = block.contentTo + (lineBreak?.length ?? 0) + (match[0].length - match[0].trimStart().length);
    return { from: markerFrom, to: markerFrom + match[1].length };
}

function createCodeBoundaryNavigationTransaction(
    state: EditorState,
    offset: number,
    direction: "backward" | "forward",
): Transaction | null {
    const block = findSourceBlockAtOffset(state.blocks, offset);
    if (!block || block.type !== "code") {
        return null;
    }

    if (direction === "backward" && offset === block.contentFrom) {
        const openingLineEnding = state.doc.slice(block.sourceFrom, block.contentFrom).match(/(\r?\n)$/)?.[1];
        if (openingLineEnding) {
            const head = block.contentFrom - openingLineEnding.length;
            return createSelectionTransaction(head);
        }
    }

    if (direction === "forward" && offset === block.contentTo) {
        const closingLineEnding = state.doc.slice(block.contentTo, block.sourceTo).match(/^(\r?\n)/)?.[1];
        if (readClosingFenceMarker(state.doc, block, block.codeFence?.[0] ?? "")) {
            return createSelectionTransaction(block.contentTo + (closingLineEnding?.length ?? 0));
        }
    }

    return null;
}

function createSelectionTransaction(head: number): Transaction {
    return {
        changes: [],
        selection: { anchor: head, head },
        annotations: { userEvent: "programmatic", addToHistory: false },
    };
}

function readTouchedCodeLineStarts(
    doc: string,
    block: SourceBlock,
    range: { from: number; to: number },
): number[] {
    const starts = [readCodeLineStart(doc, block, range.from)];
    const effectiveEnd = range.to > range.from && readCodeLineStart(doc, block, range.to) === range.to
        ? range.to - 1
        : range.to;
    let cursor = doc.indexOf("\n", starts[0]);
    while (cursor >= 0 && cursor < effectiveEnd && cursor + 1 <= block.contentTo) {
        starts.push(cursor + 1);
        cursor = doc.indexOf("\n", cursor + 1);
    }
    return starts;
}

function readCodeLineStart(doc: string, block: SourceBlock, offset: number): number {
    return Math.max(block.contentFrom, doc.lastIndexOf("\n", Math.max(block.contentFrom, offset - 1)) + 1);
}

function createCodeOutdentChange(doc: string, lineStart: number): Change | null {
    if (doc[lineStart] === "\t") {
        return { from: lineStart, to: lineStart + 1, insert: "" };
    }

    const spaces = doc.slice(lineStart, lineStart + 4).match(/^ {1,4}/)?.[0].length ?? 0;
    return spaces > 0 ? { from: lineStart, to: lineStart + spaces, insert: "" } : null;
}

function createReplaceSelectionTransaction(
    state: EditorState,
    text: string,
    userEvent: NonNullable<Transaction["annotations"]>["userEvent"],
    historyMode?: NonNullable<Transaction["annotations"]>["historyMode"],
): Transaction {
    const range = orderedSelection(state);
    const head = range.from + text.length;

    return {
        changes: [{ from: range.from, to: range.to, insert: text }],
        selection: { anchor: head, head },
        annotations: { userEvent, historyMode },
    };
}

function createDeleteRangeTransaction(
    from: number,
    to: number,
    userEvent: NonNullable<Transaction["annotations"]>["userEvent"],
    historyMode?: NonNullable<Transaction["annotations"]>["historyMode"],
): Transaction {
    return {
        changes: [{ from, to, insert: "" }],
        selection: { anchor: from, head: from },
        annotations: { userEvent, historyMode },
    };
}

function readDeleteBoundary(
    doc: string,
    offset: number,
    direction: DeleteDirection,
    granularity: DeleteGranularity,
): number {
    if (granularity === "word") {
        return direction === "backward" ? previousWordBoundary(doc, offset) : nextWordBoundary(doc, offset);
    }

    if (granularity === "soft-line" || granularity === "hard-line") {
        return direction === "backward" ? previousLineBoundary(doc, offset) : nextLineBoundary(doc, offset);
    }

    return direction === "backward" ? previousGraphemeBoundary(doc, offset) : nextGraphemeBoundary(doc, offset);
}

function orderedSelection(state: EditorState): { from: number; to: number } {
    return {
        from: Math.min(state.selection.anchor, state.selection.head),
        to: Math.max(state.selection.anchor, state.selection.head),
    };
}

function canExitEmptyContinuationBlock(block: SourceBlock): boolean {
    return (
        block.contentFrom === block.contentTo &&
        (isListBlock(block) || block.type === "quote")
    );
}

function readSelectedListBlocks(state: EditorState): SourceBlock[] {
    const range = orderedSelection(state);
    if (range.from === range.to) {
        const block = findSourceBlockAtOffset(state.blocks, range.from);
        return block && isListBlock(block) ? [block] : [];
    }

    return state.blocks.blocks.filter((block) => isListBlock(block) && isBlockTouchedByRange(block, range));
}

function isBlockTouchedByRange(block: SourceBlock, range: { from: number; to: number }): boolean {
    return range.from <= block.sourceTo && range.to > block.sourceFrom;
}

function createIndentListBlockChange(doc: string, block: SourceBlock, delta: -1 | 1): Change | null {
    const indent = Math.max(0, Math.min(block.indent ?? 0, 3));

    if (delta > 0) {
        return indent >= 3 ? null : { from: block.sourceFrom, to: block.sourceFrom, insert: "  " };
    }

    if (indent <= 0) {
        return null;
    }

    const leadingWhitespaceLength = readLeadingWhitespaceLength(doc, block);
    if (leadingWhitespaceLength === 0) {
        return null;
    }

    return {
        from: block.sourceFrom,
        to: block.sourceFrom + leadingWhitespaceLength,
        insert: serializeIndent(indent - 1),
    };
}

function readLeadingWhitespaceLength(doc: string, block: SourceBlock): number {
    return doc.slice(block.sourceFrom, block.sourceTo).match(/^[ \t]*/)?.[0].length ?? 0;
}

function readResetBlockPrefixRange(state: EditorState, offset: number): { from: number; to: number } | null {
    const block = findSourceBlockAtOffset(state.blocks, offset);
    if (!block || offset !== block.contentFrom || block.contentFrom <= block.sourceFrom) {
        return null;
    }

    if (!canResetBlockPrefix(block)) {
        return null;
    }

    return {
        from: block.sourceFrom,
        to: block.contentFrom,
    };
}

function canResetBlockPrefix(block: SourceBlock): boolean {
    return (
        block.type === "list" ||
        block.type === "ordered-list" ||
        block.type === "todo" ||
        block.type === "quote" ||
        block.type.startsWith("heading-")
    );
}

function readHiddenListIndentRange(state: EditorState, offset: number): { from: number; to: number } | null {
    const block = findSourceBlockAtOffset(state.blocks, offset);
    if (!block || !isListBlock(block) || !block.indent) {
        return null;
    }

    const visiblePrefixLength = readVisibleListPrefixLength(block);
    const hiddenIndentTo = block.contentFrom - visiblePrefixLength;
    if (hiddenIndentTo <= block.sourceFrom) {
        return null;
    }

    return {
        from: block.sourceFrom,
        to: hiddenIndentTo,
    };
}

function isListBlock(block: SourceBlock): boolean {
    return block.type === "list" || block.type === "ordered-list" || block.type === "todo";
}

function findTodoMarkerOffset(doc: string, block: SourceBlock): number {
    const source = doc.slice(block.sourceFrom, block.sourceTo);
    const marker = source.match(/\[[ xX]\]/);
    return marker?.index === undefined ? -1 : block.sourceFrom + marker.index + 1;
}

function readLineContinuationPrefix(block: SourceBlock): string {
    if (block.type === "list") {
        return `${serializeIndent(block.indent)}${block.listMarker ?? "-"} `;
    }

    if (block.type === "ordered-list") {
        const number = Number(block.listNumber ?? "1");
        return `${serializeIndent(block.indent)}${Number.isFinite(number) ? number + 1 : 1}. `;
    }

    if (block.type === "todo") {
        return `${serializeIndent(block.indent)}${block.listMarker ?? "-"} [ ] `;
    }

    if (block.type === "quote") {
        return `${">".repeat(Math.max(1, block.quoteLevel ?? 1))} `;
    }

    return "";
}

function serializeIndent(indent: number | undefined): string {
    return "  ".repeat(Math.max(0, Math.min(indent ?? 0, 3)));
}
