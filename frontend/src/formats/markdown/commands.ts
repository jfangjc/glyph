import { findSourceBlockAtOffset, isSourceSelection, readVisibleListPrefixLength, type Change, type EditorState, type SourceBlock, type Transaction } from "../../editor/core/types";
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
    readMarkdownTableCellAtOffset,
    readMarkdownTableCellFocusOffset,
    readMarkdownTableColumnCount,
} from "./table";
import { isCompleteInlineFormatToken, readInlineSourceTokenRanges } from "./inline";
import { applyTransactionToDoc, mapOffset } from "../../editor/core/transaction";
import { buildBlockIndex } from "./block-index";
import type { BlockFormatCommand, InlineFormatCommand, InsertContentCommand } from "../types";

export type DeleteDirection = "backward" | "forward";
export type DeleteGranularity = "grapheme" | "word" | "soft-line" | "hard-line";

export function createInsertTextTransaction(state: EditorState, text: string): Transaction {
    const normalizedText = normalizeInsertedText(text);
    return createCodeBodyReplaceTransaction(state, normalizedText, "input", "typing")
        ?? createIndentedCodeReplaceTransaction(state, normalizedText, "input", "typing")
        ?? createReplaceSelectionTransaction(state, normalizedText, "input", "typing");
}

export function createPasteTransaction(state: EditorState, text: string): Transaction {
    const insertedText = normalizeInsertedText(text);
    const linkPaste = createUrlOverSelectionTransaction(state, insertedText);
    if (linkPaste) {
        return linkPaste;
    }
    const normalizedText = normalizeBlockPasteForContext(state, insertedText);
    return createCodeBodyReplaceTransaction(state, normalizedText, "paste", "discrete")
        ?? createIndentedCodeReplaceTransaction(state, normalizedText, "paste", "discrete")
        ?? createReplaceSelectionTransaction(state, normalizedText, "paste");
}

export function createEnterTransaction(state: EditorState, options: { shiftKey?: boolean } = {}): Transaction {
    const range = orderedSelection(state);
    const codeLineBreak = createCodeLineBreakTransaction(state);
    if (codeLineBreak) {
        return codeLineBreak;
    }
    if (range.from !== range.to) {
        const semanticRange = expandInlineVisualSelectionRange(state, range);
        const doc = state.doc.slice(0, semanticRange.from) + state.doc.slice(semanticRange.to);
        const selection = { anchor: semanticRange.from, head: semanticRange.from, source: state.selection.source };
        const afterDelete = { ...state, doc, selection, blocks: buildBlockIndex(doc) };
        const split = createEnterTransaction(afterDelete, options);
        const result = applyTransactionToDoc(doc, selection, split);
        let from = 0;
        while (from < state.doc.length && from < result.doc.length && state.doc[from] === result.doc[from]) from += 1;
        let to = state.doc.length;
        let end = result.doc.length;
        while (to > from && end > from && state.doc[to - 1] === result.doc[end - 1]) { to -= 1; end -= 1; }
        return { changes: [{ from, to, insert: result.doc.slice(from, end) }], selection: result.selection, annotations: { userEvent: "input", historyMode: "discrete" } };
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

    if (!options.shiftKey && block && canExitEmptyContinuationBlock(block) && range.from === block.contentFrom) {
        return {
            changes: [{ from: block.sourceFrom, to: block.sourceTo, insert: "" }],
            selection: { anchor: block.sourceFrom, head: block.sourceFrom },
            annotations: { userEvent: "input" },
        };
    }

    const continuation = block ? readLineContinuationPrefix(block) : "";
    if (block && continuation && range.from >= block.contentFrom && range.from <= block.contentTo) {
        const prefix = state.doc.slice(block.sourceFrom, block.contentFrom);
        const hardBreakPrefix = block.type === "quote" ? continuation : " ".repeat(prefix.length);
        const insert = options.shiftKey ? `  \n${hardBreakPrefix}` : `\n${continuation}`;
        const head = range.from + insert.length;
        return {
            changes: [{ from: range.from, to: range.from, insert }],
            selection: { anchor: head, head },
            annotations: { userEvent: "input" },
        };
    }

    if (block?.type === "paragraph" && range.from >= block.contentFrom && range.from <= block.contentTo) {
        if (isOpenFencedCodeParagraph(state.doc.slice(block.sourceFrom, block.sourceTo))) {
            return createReplaceSelectionTransaction(state, "\n", "input");
        }

        const insert = options.shiftKey ? "  \n" : "\n\n";
        return createReplaceSelectionTransaction(state, insert, "input");
    }

    return createReplaceSelectionTransaction(state, "\n", "input");
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
    if (targetLineIndex >= lines.length) {
        if (delta < 0) {
            return createSelectionTransaction(range.from);
        }
        const row = createEmptyMarkdownTableRow(columnCount);
        const separator = source.endsWith("\n") ? "" : "\n";
        const rowCellOffset = readMarkdownTableCellFocusOffset(row, 0, 0) ?? 0;
        const target = block.sourceTo + separator.length + rowCellOffset;
        return {
            changes: [{ from: block.sourceTo, to: block.sourceTo, insert: `${separator}${row}` }],
            selection: { anchor: target, head: target },
            annotations: { userEvent: "input", historyMode: "discrete" },
        };
    }

    const targetOffset = readMarkdownTableCellFocusOffset(source, targetLineIndex, targetCellIndex);
    if (targetOffset === null) {
        return null;
    }

    return createSelectionTransaction(block.sourceFrom + targetOffset);
}

function createUrlOverSelectionTransaction(state: EditorState, text: string): Transaction | null {
    const url = text.trim();
    if (!/^(?:https?:\/\/|mailto:)[^\s<>]+$/i.test(url)) {
        return null;
    }

    const selected = orderedSelection(state);
    if (selected.from === selected.to) {
        return null;
    }
    const range = expandVisualSelectionRange(state, selected);
    const block = findSourceBlockAtOffset(state.blocks, range.from);
    if (
        !block ||
        !isRichMarkdownBlock(block.type) ||
        range.to > block.contentTo ||
        state.doc.slice(range.from, range.to).includes("\n")
    ) {
        return null;
    }

    const label = state.doc.slice(selected.from, selected.to).replace(/([\\\]])/g, "\\$1");
    const destination = url.replace(/([\\()])/g, "\\$1");
    const source = `[${label}](${destination})`;
    const head = range.from + source.length;
    return {
        changes: [{ from: range.from, to: range.to, insert: source }],
        selection: { anchor: head, head },
        annotations: { userEvent: "paste", historyMode: "discrete" },
    };
}

function normalizeBlockPasteForContext(state: EditorState, text: string): string {
    if (!/(^|\n)(?:#{1,6}\s|[-+*]\s|\d+[.)]\s|>\s|```|~~~|\$\$\s*$|\|.+\||<[A-Za-z])/m.test(text)) {
        return text;
    }

    const range = orderedSelection(state);
    const block = findSourceBlockAtOffset(state.blocks, range.from);
    if (!block || block.type !== "paragraph" || range.from < block.contentFrom || range.to > block.contentTo) {
        return text;
    }

    const before = range.from > block.contentFrom ? "\n\n" : "";
    const after = range.to < block.contentTo ? "\n\n" : "";
    return `${before}${text.replace(/^\n+|\n+$/g, "")}${after}`;
}

function isOpenFencedCodeParagraph(source: string): boolean {
    const openingLine = source.split(/\r?\n/, 1)[0];
    return /^ {0,3}(?:`{3,}|~{3,})(.*)$/.test(openingLine);
}

function createTableEnterTransaction(state: EditorState, block: SourceBlock, offset: number): Transaction | null {
    if (block.type !== "table" || offset < block.sourceFrom || offset > block.sourceTo) {
        return null;
    }

    if (offset === block.sourceTo) {
        return createTableExitTransaction(state, block, false);
    }

    return createReplaceSelectionTransaction(state, "\n", "input");
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
    const selectedIds = new Set(blocks.map((block) => block.id));
    const changes = blocks
        .filter((block) => step < 0 || canIndentListBlock(state, block, selectedIds))
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

export function createDeleteTransaction(
    state: EditorState,
    direction: DeleteDirection,
    granularity: DeleteGranularity,
): Transaction | null {
    const range = orderedSelection(state);
    if (range.from !== range.to) {
        // A WYSIWYG text selection owns the visible text, not a block's hidden
        // Markdown prefix. Explicit block/source selections already include
        // those source offsets and therefore still delete the whole block.
        const deletionRange = resolveMarkdownSemanticSelection(state, range, {
            includeBlockSource: false,
            includeAtomicObjects: true,
        });
        return createDeleteRangeTransaction(deletionRange.from, deletionRange.to, "delete");
    }

    const offset = range.from;
    if (direction === "backward" && offset <= 0 || direction === "forward" && offset >= state.doc.length) {
        return null;
    }

    const codeBoundaryNavigation = createCodeBoundaryNavigationTransaction(state, offset, direction);
    if (codeBoundaryNavigation) {
        return codeBoundaryNavigation;
    }

    if (granularity === "grapheme" && !isSourceSelection(state.selection)) {
        const blocks = state.blocks.blocks;
        const leftIndex = direction === "forward"
            ? blocks.findIndex(block => block.contentTo === offset)
            : blocks.findIndex(block => block.contentFrom === offset) - 1;
        const left = blocks[leftIndex];
        const right = blocks[leftIndex + 1];
        if (left && right) {
            const separator = state.doc.slice(left.sourceTo, right.sourceFrom);
            const paragraphs = left.type === "paragraph" && right.type === "paragraph" && /^\n{1,2}$/.test(separator);
            const lists = isListBlock(left) && isListBlock(right) && left.type === right.type &&
                (left.indent ?? 0) === (right.indent ?? 0) && /^\r?\n$/.test(separator);
            if (paragraphs) {
                const empty = left.contentFrom === left.contentTo ? left : right.contentFrom === right.contentTo ? right : null;
                const emptyIndex = empty === left ? leftIndex : leftIndex + 1;
                const before = blocks[emptyIndex - 1];
                const after = blocks[emptyIndex + 1];
                // An odd run of three newlines has one editable blank between
                // two paragraphs. Removing it retains their two-line separator.
                if (empty && before && after && /^\n{3}$/.test(state.doc.slice(before.sourceTo, after.sourceFrom))) {
                    return empty === right
                        ? createDeleteRangeTransaction(left.contentTo, left.contentTo + 1, "delete")
                        : createDeleteRangeTransaction(right.contentFrom - 1, right.contentFrom, "delete");
                }
                return createDeleteRangeTransaction(left.contentTo, right.contentFrom, "delete");
            }
            if (lists) return createDeleteRangeTransaction(left.contentTo, right.contentFrom, "delete");
            // Incompatible structures require an explicit second action inside
            // the neighbor instead of exposing its hidden marker by accident.
            if (direction === "forward" && right.contentFrom > right.sourceFrom && /^\r?\n$/.test(separator)) {
                return createSelectionTransaction(right.contentFrom);
            }
        }
    }

    if (direction === "backward" && !isSourceSelection(state.selection)) {
        const listStartBackspace = createListStartBackspaceTransaction(state, offset);
        if (listStartBackspace) {
            return listStartBackspace;
        }

        const hiddenIndentRange = readHiddenListIndentRange(state, offset);
        if (hiddenIndentRange && offset > hiddenIndentRange.from && offset <= hiddenIndentRange.to) {
            if (offset === hiddenIndentRange.to) {
                return createIndentListTransaction(state, -1);
            }

            return createSelectionTransaction(hiddenIndentRange.to);
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

function createListStartBackspaceTransaction(state: EditorState, offset: number): Transaction | null {
    const block = findSourceBlockAtOffset(state.blocks, offset);
    if (
        !block ||
        !isListBlock(block) ||
        offset !== block.contentFrom
    ) {
        return null;
    }

    if (block.contentFrom < block.contentTo) {
        const blockIndex = state.blocks.blocks.findIndex((candidate) => candidate.id === block.id);
        const previous = blockIndex > 0 ? state.blocks.blocks[blockIndex - 1] : null;
        const separator = previous ? state.doc.slice(previous.sourceTo, block.sourceFrom) : "";
        if (
            previous &&
            isListBlock(previous) &&
            previous.type === block.type &&
            (previous.indent ?? 0) === (block.indent ?? 0) &&
            /^\r?\n$/.test(separator)
        ) {
            return createDeleteRangeTransaction(previous.contentTo, block.contentFrom, "delete", "typing");
        }
    }

    return block.indent ? createIndentListTransaction(state, -1) : null;
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

export function createInlineFormatTransaction(state: EditorState, command: InlineFormatCommand): Transaction | null {
    if (command === "link") {
        return createLinkTransaction(state);
    }
    if (command === "code") {
        return createInlineCodeTransaction(state);
    }

    const marker = command === "bold" ? "**" : command === "italic" ? "*" : "~~";
    return createInlineMarkerTransaction(state, marker);
}

function createInlineMarkerTransaction(state: EditorState, marker: "*" | "**" | "~~"): Transaction | null {
    const range = orderedSelection(state);
    if (range.from === range.to) {
        return null;
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

    return {
        changes,
        selection: {
            anchor: mapOffset(
                state.selection.anchor,
                changes,
                state.selection.anchor <= state.selection.head ? "downstream" : "upstream",
            ),
            head: mapOffset(
                state.selection.head,
                changes,
                state.selection.anchor <= state.selection.head ? "upstream" : "downstream",
            ),
            anchorAffinity: state.selection.anchorAffinity,
            headAffinity: state.selection.headAffinity,
        },
        annotations: { userEvent: "format" },
    };
}

function createInlineCodeTransaction(state: EditorState): Transaction | null {
    const range = orderedSelection(state);
    if (range.from === range.to) return null;
    const segments = readFormattableSegments(state, range);
    if (segments.length === 0) return null;

    const removeFormatting = segments.every((segment) => readInlineCodeRemoval(state.doc, segment) !== null);
    const changes = segments.flatMap((segment): Change[] => {
        const removal = readInlineCodeRemoval(state.doc, segment);
        if (removeFormatting && removal) return removal;
        if (removal) return [];

        const selected = state.doc.slice(segment.from, segment.to);
        const marker = readPendingFormatMarker("code", selected);
        const needsPadding = selected.startsWith("`") || selected.endsWith("`") || (
            selected.startsWith(" ") && selected.endsWith(" ") && selected.trim() !== ""
        );
        const padding = needsPadding ? " " : "";
        return [
            { from: segment.from, to: segment.from, insert: `${marker}${padding}` },
            { from: segment.to, to: segment.to, insert: `${padding}${marker}` },
        ];
    });

    return {
        changes,
        selection: {
            anchor: mapOffset(
                state.selection.anchor,
                changes,
                state.selection.anchor <= state.selection.head ? "downstream" : "upstream",
            ),
            head: mapOffset(
                state.selection.head,
                changes,
                state.selection.anchor <= state.selection.head ? "upstream" : "downstream",
            ),
            anchorAffinity: state.selection.anchorAffinity,
            headAffinity: state.selection.headAffinity,
        },
        annotations: { userEvent: "format" },
    };
}

function readInlineCodeRemoval(doc: string, segment: { from: number; to: number }): Change[] | null {
    const token = readInlineSourceTokenRanges(doc).find((candidate) => (
        doc[candidate.from] === "`" &&
        candidate.contentFrom !== null &&
        candidate.contentTo !== null &&
        (candidate.from === segment.from && candidate.to === segment.to ||
            candidate.contentFrom === segment.from && candidate.contentTo === segment.to)
    ));
    if (!token || token.contentFrom === null || token.contentTo === null) return null;
    return [
        { from: token.from, to: token.contentFrom, insert: "" },
        { from: token.contentTo, to: token.to, insert: "" },
    ];
}

export function createPendingInlineFormatInsertTransaction(
    state: EditorState,
    text: string,
    commands: readonly Exclude<InlineFormatCommand, "link">[],
): Transaction | null {
    const range = orderedSelection(state);
    const block = findSourceBlockAtOffset(state.blocks, range.from);
    if (
        range.from !== range.to ||
        !block ||
        !isRichMarkdownBlock(block.type) ||
        text === "" ||
        /^[\s\p{P}\p{S}]+$/u.test(text)
    ) {
        return null;
    }

    const requested = new Set(commands);
    const activeCommands: Exclude<InlineFormatCommand, "link">[] = requested.has("code")
        ? ["code"]
        : (["bold", "italic", "strike"] as const).filter((command) => requested.has(command));
    if (activeCommands.length === 0) {
        return null;
    }

    const markers = activeCommands.map((command) => readPendingFormatMarker(command, text));
    const codePadding = activeCommands[0] === "code" && (
        text.startsWith("`") || text.endsWith("`") ||
        (text.startsWith(" ") && text.endsWith(" ") && text.trim() !== "")
    ) ? " " : "";
    const opening = `${markers.join("")}${codePadding}`;
    const closing = `${codePadding}${[...markers].reverse().join("")}`;
    const insert = `${opening}${text}${closing}`;
    const caret = range.from + opening.length + text.length;
    return {
        changes: [{ from: range.from, to: range.to, insert }],
        selection: { anchor: caret, head: caret },
        annotations: { userEvent: "input", historyMode: "typing", typingBoundary: false },
    };
}

function readPendingFormatMarker(command: Exclude<InlineFormatCommand, "link">, text: string): string {
    if (command === "bold") return "**";
    if (command === "italic") return "*";
    if (command === "strike") return "~~";

    const longestRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
    return "`".repeat(longestRun + 1);
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
    marker: "*" | "**" | "~~",
): Change[] | null {
    const selected = doc.slice(segment.from, segment.to);
    if (isCompleteMarkerToken(selected, marker)) {
        return [
            { from: segment.from, to: segment.from + marker.length, insert: "" },
            { from: segment.to - marker.length, to: segment.to, insert: "" },
        ];
    }

    const surroundingFrom = Math.max(0, segment.from - marker.length);
    const surrounding = doc.slice(surroundingFrom, segment.to + marker.length);
    if (isCompleteMarkerToken(surrounding, marker)) {
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

function isCompleteMarkerToken(source: string, marker: "*" | "**" | "~~"): boolean {
    if (marker === "*" || marker === "**") {
        return isCompleteInlineFormatToken(source, marker);
    }
    return source.length >= marker.length * 2 && source.startsWith(marker) && source.endsWith(marker);
}

function createLinkTransaction(state: EditorState): Transaction | null {
    const range = orderedSelection(state);
    const block = findSourceBlockAtOffset(state.blocks, range.from);
    if (!block || !isRichMarkdownBlock(block.type) || range.to > block.contentTo) {
        return null;
    }

    const label = range.from === range.to ? "link text" : state.doc.slice(range.from, range.to);
    const source = `[${label}](https://)`;
    const urlFrom = range.from + label.length + 3;
    return {
        changes: [{ from: range.from, to: range.to, insert: source }],
        selection: { anchor: urlFrom, head: urlFrom + "https://".length },
        annotations: { userEvent: "format" },
    };
}

export function createBlockFormatTransaction(state: EditorState, command: BlockFormatCommand): Transaction | null {
    const range = orderedSelection(state);
    const blocks = state.blocks.blocks.filter((block) => (
        range.from === range.to
            ? range.from >= block.sourceFrom && range.from <= block.sourceTo
            : range.from <= block.sourceTo && range.to >= block.sourceFrom
    )).filter((block) => block.type !== "source" && block.type !== "table" && block.type !== "math" && block.type !== "html");
    if (blocks.length === 0) {
        return null;
    }

    const changes = blocks.map((block, index): Change => ({
        from: block.sourceFrom,
        to: block.sourceTo,
        insert: serializeBlockAs(command, state.doc.slice(block.contentFrom, block.contentTo), index),
    }));
    return { changes, annotations: { userEvent: "format" } };
}

export function createInsertContentTransaction(state: EditorState, command: InsertContentCommand): Transaction | null {
    const range = orderedSelection(state);
    const source = readInsertedContentSource(command);
    const blockInsertion = command === "table" || command === "rule";
    const before = blockInsertion && range.from > 0 && !state.doc.slice(0, range.from).endsWith("\n\n") ? "\n\n" : "";
    const after = blockInsertion && range.to < state.doc.length && !state.doc.slice(range.to).startsWith("\n\n") ? "\n\n" : "";
    const insert = `${before}${source}${after}`;
    const placeholder = command === "image" ? "Alt text" : command === "math" ? "x" : command === "table" ? "Column 1" : "";
    const placeholderFrom = range.from + before.length + (placeholder ? source.indexOf(placeholder) : source.length);
    return {
        changes: [{ from: range.from, to: range.to, insert }],
        selection: placeholder
            ? { anchor: placeholderFrom, head: placeholderFrom + placeholder.length }
            : { anchor: range.from + insert.length, head: range.from + insert.length },
        annotations: { userEvent: "format" },
    };
}

function readInsertedContentSource(command: InsertContentCommand): string {
    if (command === "table") return "| Column 1 | Column 2 |\n| --- | --- |\n|  |  |";
    if (command === "image") return "![Alt text](image-url){width=auto align=center}";
    if (command === "math") return "$x$";
    return "---";
}

function serializeBlockAs(command: BlockFormatCommand, text: string, index: number): string {
    if (command === "paragraph") return text;
    if (command.startsWith("heading-")) {
        const level = Number(command.slice("heading-".length));
        return `${"#".repeat(Math.max(1, Math.min(6, level)))} ${text}`;
    }
    if (command === "list") return `- ${text}`;
    if (command === "ordered-list") return `${index + 1}. ${text}`;
    if (command === "todo") return `- [ ] ${text}`;
    if (command === "quote") return text.split("\n").map((line) => `> ${line}`).join("\n");
    return `\`\`\`\n${text}\n\`\`\``;
}

export function readSelectedSourceRange(state: EditorState): { from: number; to: number } | null {
    const selected = orderedSelection(state);
    if (selected.from === selected.to) return null;
    const range = resolveMarkdownSemanticSelection(state, selected, {
        includeBlockSource: true,
        includeAtomicObjects: false,
    });
    return range.from === range.to ? null : range;
}

export function readMarkdownVisualSelectionRange(state: EditorState): { from: number; to: number } | null {
    const selected = orderedSelection(state);
    if (isSourceSelection(state.selection)) {
        return null;
    }

    const from = normalizeVisualSelectionBoundary(state, selected.from, "start");
    const to = normalizeVisualSelectionBoundary(state, selected.to, "end");
    if (selected.from === selected.to) {
        return from !== selected.from || to !== selected.to ? { from, to } : null;
    }

    return from <= to ? { from, to } : null;
}

export function readMarkdownVisualHiddenRanges(state: EditorState): Array<{
    from: number;
    to: number;
    visibleFrom: number;
    visibleTo: number;
    atomic?: boolean;
}> {
    return state.blocks.blocks.flatMap((block) => {
        if (!isRichMarkdownBlock(block.type)) return [];
        return readInlineSourceTokenRanges(state.doc.slice(block.contentFrom, block.contentTo)).map((token) => {
            const from = block.contentFrom + token.from;
            const to = block.contentFrom + token.to;
            return token.contentFrom === null || token.contentTo === null
                ? { from, to, visibleFrom: from, visibleTo: to, atomic: true }
                : {
                    from,
                    to,
                    visibleFrom: block.contentFrom + token.contentFrom,
                    visibleTo: block.contentFrom + token.contentTo,
                };
        });
    });
}

function normalizeVisualSelectionBoundary(
    state: EditorState,
    offset: number,
    boundary: "start" | "end",
): number {
    const block = findSourceBlockAtOffset(
        state.blocks,
        offset,
        boundary === "start" ? "downstream" : "upstream",
    );
    if (!block || !canResetBlockPrefix(block)) {
        return offset;
    }

    const insideHiddenPrefix = boundary === "start"
        ? offset >= block.sourceFrom && offset < block.contentFrom
        : offset >= block.sourceFrom && offset <= block.contentFrom;
    return insideHiddenPrefix ? block.contentFrom : offset;
}

function resolveMarkdownSemanticSelection(
    state: EditorState,
    selected: { from: number; to: number },
    options: { includeBlockSource: boolean; includeAtomicObjects: boolean },
): { from: number; to: number } {
    let range = options.includeBlockSource
        ? expandVisualSelectionRange(state, selected)
        : expandInlineVisualSelectionRange(state, selected);
    if (options.includeAtomicObjects) {
        range = expandStandaloneImageDeletionRange(state, range);
    }
    return range;
}

function expandVisualSelectionRange(
    state: EditorState,
    range: { from: number; to: number },
): { from: number; to: number } {
    if (isSourceSelection(state.selection)) return range;
    let expanded = expandInlineVisualSelectionRange(state, range);
    let changed = true;

    while (changed) {
        changed = false;
        for (const block of state.blocks.blocks) {
            if (expanded.to < block.contentFrom || expanded.from > block.contentTo) {
                continue;
            }

            const coversBlockContent = expanded.from <= block.contentFrom && expanded.to >= block.contentTo;
            const expandLeadingSource = coversBlockContent && expanded.from === block.contentFrom;
            const expandTrailingSource = coversBlockContent && expanded.to === block.contentTo;
            if (expandLeadingSource || expandTrailingSource) {
                const next = {
                    from: expandLeadingSource ? block.sourceFrom : expanded.from,
                    to: expandTrailingSource ? block.sourceTo : expanded.to,
                };
                if (next.from !== expanded.from || next.to !== expanded.to) {
                    expanded = next;
                    changed = true;
                }
            }
        }
    }

    return expanded;
}

function expandInlineVisualSelectionRange(
    state: EditorState,
    range: { from: number; to: number },
): { from: number; to: number } {
    if (isSourceSelection(state.selection)) return range;
    let expanded = { ...range };
    for (const block of state.blocks.blocks) {
        if (
            !isRichMarkdownBlock(block.type) ||
            range.to < block.contentFrom ||
            range.from > block.contentTo
        ) {
            continue;
        }

        const content = state.doc.slice(block.contentFrom, block.contentTo);
        const tokens = readInlineSourceTokenRanges(content).map((token) => ({
            from: block.contentFrom + token.from,
            to: block.contentFrom + token.to,
            contentFrom: token.contentFrom === null ? null : block.contentFrom + token.contentFrom,
            contentTo: token.contentTo === null ? null : block.contentFrom + token.contentTo,
        }));
        let changed = true;
        while (changed) {
            changed = false;
            for (const token of tokens) {
                if (
                    token.contentFrom === null ||
                    token.contentTo === null ||
                    isSelectionContainedByNestedToken(range, token, tokens)
                ) {
                    continue;
                }
                const coversVisibleContent = expanded.from <= token.contentFrom &&
                    expanded.to >= token.contentTo;
                const next = {
                    from: coversVisibleContent &&
                        expanded.from >= token.from && expanded.from <= token.contentFrom
                        ? token.from
                        : expanded.from,
                    to: coversVisibleContent &&
                        expanded.to >= token.contentTo && expanded.to <= token.to
                        ? token.to
                        : expanded.to,
                };
                if (next.from !== expanded.from || next.to !== expanded.to) {
                    expanded = next;
                    changed = true;
                }
            }
        }
    }

    return expanded;
}

function isSelectionContainedByNestedToken(
    selection: { from: number; to: number },
    token: { from: number; to: number },
    tokens: Array<{ from: number; to: number }>,
): boolean {
    return tokens.some((nested) => (
        nested !== token &&
        nested.from >= token.from &&
        nested.to <= token.to &&
        (nested.from > token.from || nested.to < token.to) &&
        selection.from >= nested.from &&
        selection.to <= nested.to
    ));
}

function expandStandaloneImageDeletionRange(
    state: EditorState,
    range: { from: number; to: number },
): { from: number; to: number } {
    const selectedContentBlocks = state.blocks.blocks.filter((block) => (
        block.contentFrom < range.to && block.contentTo > range.from && block.contentFrom !== block.contentTo
    ));
    const first = selectedContentBlocks[0];
    const last = selectedContentBlocks[selectedContentBlocks.length - 1];
    if (
        !first ||
        !last ||
        range.from !== first.contentFrom ||
        range.to !== last.contentTo ||
        !selectedContentBlocks.every((block) => isStandaloneImageBlock(state, block))
    ) {
        return range;
    }

    if (state.doc.slice(range.to, range.to + 2) === "\n\n") {
        return { from: range.from, to: range.to + 2 };
    }
    if (state.doc.slice(Math.max(0, range.from - 2), range.from) === "\n\n") {
        return { from: range.from - 2, to: range.to };
    }
    return range;
}

function isStandaloneImageBlock(state: EditorState, block: SourceBlock): boolean {
    if (block.type !== "paragraph") return false;
    const content = state.doc.slice(block.contentFrom, block.contentTo);
    if (!content.startsWith("![")) return false;
    const tokens = readInlineSourceTokenRanges(content);
    return tokens.length === 1 && tokens[0].from === 0 && tokens[0].to === content.length;
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

function createCodeLineBreakTransaction(state: EditorState): Transaction | null {
    const range = orderedSelection(state);
    const block = state.blocks.blocks.find((candidate) => (
        candidate.type === "code" &&
        range.from >= candidate.contentFrom &&
        range.to <= candidate.contentTo
    ));
    if (!block) {
        return null;
    }

    const lineFrom = state.doc.lastIndexOf("\n", Math.max(block.contentFrom, range.from) - 1) + 1;
    const indent = state.doc.slice(lineFrom, range.from).match(/^[ \t]*/)?.[0] ?? "";
    const insert = `\n${indent}`;
    return createCodeBodyReplaceTransaction(state, insert, "input")
        ?? createReplaceSelectionTransaction(state, insert, "input");
}

function createIndentedCodeReplaceTransaction(
    state: EditorState,
    text: string,
    userEvent: NonNullable<Transaction["annotations"]>["userEvent"],
    historyMode?: NonNullable<Transaction["annotations"]>["historyMode"],
): Transaction | null {
    const range = orderedSelection(state);
    const block = state.blocks.blocks.find((candidate) => (
        candidate.type === "code" &&
        !candidate.codeFence &&
        range.from >= candidate.contentFrom &&
        range.to <= candidate.contentTo
    ));
    if (!block) {
        return null;
    }

    const lineFrom = state.doc.lastIndexOf("\n", Math.max(block.contentFrom, range.from) - 1) + 1;
    const indent = state.doc.slice(lineFrom).match(/^[ \t]*/)?.[0] || "    ";
    const insert = text.replace(/\n/g, `\n${indent}`);
    return createReplaceSelectionTransaction(state, insert, userEvent, historyMode);
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

    const openingLineEnding = state.doc.slice(block.sourceFrom, block.contentFrom).match(/(\r?\n)$/)?.[1];
    const openingBoundary = block.contentFrom - (openingLineEnding?.length ?? 0);
    if (openingLineEnding && direction === "backward" && offset === block.contentFrom) {
        return createSelectionTransaction(openingBoundary);
    }
    if (openingLineEnding && direction === "forward" && offset === openingBoundary) {
        return createSelectionTransaction(block.contentFrom);
    }

    const closingLineEnding = state.doc.slice(block.contentTo, block.sourceTo).match(/^(\r?\n)/)?.[1];
    const closingBoundary = block.contentTo + (closingLineEnding?.length ?? 0);
    if (readClosingFenceMarker(state.doc, block, block.codeFence?.[0] ?? "")) {
        if (direction === "forward" && offset === block.contentTo) {
            return createSelectionTransaction(closingBoundary);
        }
        if (closingLineEnding && direction === "backward" && offset === closingBoundary) {
            return createSelectionTransaction(block.contentTo);
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

function canIndentListBlock(state: EditorState, block: SourceBlock, selectedIds: Set<string>): boolean {
    const index = state.blocks.blocks.findIndex((candidate) => candidate.id === block.id);
    if (index <= 0) {
        return false;
    }

    const previous = state.blocks.blocks[index - 1];
    if (selectedIds.has(previous.id)) {
        return true;
    }
    if (!isListBlock(previous)) {
        return false;
    }

    const indent = Math.max(0, block.indent ?? 0);
    return Math.max(0, previous.indent ?? 0) >= indent;
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
        return `${serializeIndent(block.indent)}${Number.isFinite(number) ? number + 1 : 1}${block.listDelimiter ?? "."} `;
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
