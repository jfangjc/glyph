import { findSourceBlockAtOffset } from "./block-index";
import type { Change, EditorState, SourceBlock, Transaction } from "./types";

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

export function createEnterTransaction(state: EditorState): Transaction {
    const range = orderedSelection(state);
    if (range.from !== range.to) {
        return createCodeBodyReplaceTransaction(state, "\n", "input")
            ?? createReplaceSelectionTransaction(state, "\n", "input");
    }

    const block = findSourceBlockAtOffset(state.blocks, range.from);
    const codeExit = block ? createCodeExitTransaction(state, block, range.from) : null;
    if (codeExit) {
        return codeExit;
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
    const range = orderedSelection(state);
    if (range.from !== range.to) {
        return createDeleteRangeTransaction(range.from, range.to, "delete");
    }

    const offset = range.from;
    if (offset <= 0) {
        return null;
    }

    const codeBoundaryNavigation = createCodeBoundaryNavigationTransaction(state, offset, "backward");
    if (codeBoundaryNavigation) {
        return codeBoundaryNavigation;
    }

    const hiddenIndentRange = readHiddenListIndentRange(state, offset);
    if (hiddenIndentRange && offset > hiddenIndentRange.from && offset <= hiddenIndentRange.to) {
        return null;
    }

    const resetRange = readResetBlockPrefixRange(state, offset);
    if (resetRange) {
        return createDeleteRangeTransaction(resetRange.from, resetRange.to, "delete");
    }

    return createDeleteRangeTransaction(offset - 1, offset, "delete", "typing");
}

export function createDeleteForwardTransaction(state: EditorState): Transaction | null {
    const range = orderedSelection(state);
    if (range.from !== range.to) {
        return createDeleteRangeTransaction(range.from, range.to, "delete");
    }

    const codeBoundaryNavigation = createCodeBoundaryNavigationTransaction(state, range.from, "forward");
    if (codeBoundaryNavigation) {
        return codeBoundaryNavigation;
    }

    if (range.from >= state.doc.length) {
        return null;
    }

    return createDeleteRangeTransaction(range.from, range.from + 1, "delete", "typing");
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
        return {
            changes: [{ from: range.from, to: range.to, insert: marker + marker }],
            selection: { anchor: range.from + marker.length, head: range.from + marker.length },
            annotations: { userEvent: "format" },
        };
    }

    const selectedText = state.doc.slice(range.from, range.to);
    const before = state.doc.slice(Math.max(0, range.from - marker.length), range.from);
    const after = state.doc.slice(range.to, range.to + marker.length);
    let changes: Change[];
    let head: number;

    if (selectedText.startsWith(marker) && selectedText.endsWith(marker) && selectedText.length >= marker.length * 2) {
        changes = [
            { from: range.to - marker.length, to: range.to, insert: "" },
            { from: range.from, to: range.from + marker.length, insert: "" },
        ];
        head = range.to - marker.length * 2;
    } else if (before === marker && after === marker) {
        changes = [
            { from: range.to, to: range.to + marker.length, insert: "" },
            { from: range.from - marker.length, to: range.from, insert: "" },
        ];
        head = range.to - marker.length;
    } else {
        changes = [
            { from: range.from, to: range.from, insert: marker },
            { from: range.to, to: range.to, insert: marker },
        ];
        head = range.to + marker.length * 2;
    }

    return {
        changes,
        selection: { anchor: range.from, head },
        annotations: { userEvent: "format" },
    };
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

function readVisibleListPrefixLength(block: SourceBlock): number {
    if (block.type === "ordered-list") {
        return `${block.listNumber ?? "1"}. `.length;
    }

    if (block.type === "todo") {
        return `${block.listMarker ?? "-"} [${block.checked ? "x" : " "}] `.length;
    }

    return `${block.listMarker ?? "-"} `.length;
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
