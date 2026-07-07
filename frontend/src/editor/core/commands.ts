import { findSourceBlockAtOffset } from "./block-index";
import type { Change, EditorState, SourceBlock, Transaction } from "./types";

export function createInsertTextTransaction(state: EditorState, text: string): Transaction {
    return createReplaceSelectionTransaction(state, text, "input");
}

export function createPasteTransaction(state: EditorState, text: string): Transaction {
    return createReplaceSelectionTransaction(state, text.replace(/\r\n?/g, "\n"), "paste");
}

export function createEnterTransaction(state: EditorState): Transaction {
    const range = orderedSelection(state);
    if (range.from !== range.to) {
        return createReplaceSelectionTransaction(state, "\n", "input");
    }

    const block = findSourceBlockAtOffset(state.blocks, range.from);
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

    return createReplaceSelectionTransaction(state, "\n", "input");
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

export function createDeleteBackwardTransaction(state: EditorState): Transaction | null {
    const range = orderedSelection(state);
    if (range.from !== range.to) {
        return createDeleteRangeTransaction(range.from, range.to, "delete");
    }

    const offset = range.from;
    if (offset <= 0) {
        return null;
    }

    const hiddenIndentRange = readHiddenListIndentRange(state, offset);
    if (hiddenIndentRange && offset > hiddenIndentRange.from && offset <= hiddenIndentRange.to) {
        return null;
    }

    const resetRange = readResetBlockPrefixRange(state, offset);
    if (resetRange) {
        return createDeleteRangeTransaction(resetRange.from, resetRange.to, "delete");
    }

    return createDeleteRangeTransaction(offset - 1, offset, "delete");
}

export function createDeleteForwardTransaction(state: EditorState): Transaction | null {
    const range = orderedSelection(state);
    if (range.from !== range.to) {
        return createDeleteRangeTransaction(range.from, range.to, "delete");
    }

    if (range.from >= state.doc.length) {
        return null;
    }

    return createDeleteRangeTransaction(range.from, range.from + 1, "delete");
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
    const range = orderedSelection(state);
    if (range.from === range.to) {
        return null;
    }

    return state.doc.slice(range.from, range.to);
}

export function createCutTransaction(state: EditorState): Transaction | null {
    const range = orderedSelection(state);
    if (range.from === range.to) {
        return null;
    }

    return createDeleteRangeTransaction(range.from, range.to, "delete");
}

function createReplaceSelectionTransaction(
    state: EditorState,
    text: string,
    userEvent: NonNullable<Transaction["annotations"]>["userEvent"],
): Transaction {
    const range = orderedSelection(state);
    const head = range.from + text.length;

    return {
        changes: [{ from: range.from, to: range.to, insert: text }],
        selection: { anchor: head, head },
        annotations: { userEvent },
    };
}

function createDeleteRangeTransaction(
    from: number,
    to: number,
    userEvent: NonNullable<Transaction["annotations"]>["userEvent"],
): Transaction {
    return {
        changes: [{ from, to, insert: "" }],
        selection: { anchor: from, head: from },
        annotations: { userEvent },
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
