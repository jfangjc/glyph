import type { BlockType, ParsedBlock } from "../../editor/blocks/model";
import type { DocumentRenderContext } from "../types";
import { escapeHtml } from "../../utils/text";
import { renderMarkdownHtmlBlock } from "./html";
import { renderLatexMath } from "./math";
import { isEscapedAt } from "./utils";

export type MarkdownTableBlock = {
    block: ParsedBlock;
    consumedLines: number;
};

type TableAlignment = "left" | "center" | "right" | null;

type ParsedMarkdownTable = {
    alignments: TableAlignment[];
    header: string[];
    rows: string[][];
};

export type MarkdownTableCellBoundary = {
    lineIndex: number;
    cellIndex: number;
    start: number;
    end: number;
};

export function readMarkdownTable(lines: string[], index: number): MarkdownTableBlock | null {
    const headerLine = lines[index];
    const delimiterLine = lines[index + 1];

    if (!headerLine || !delimiterLine || !isPotentialTableRow(headerLine)) {
        return null;
    }

    const delimiter = parseTableDelimiterRow(delimiterLine);
    if (!delimiter) {
        return null;
    }

    const header = splitTableRow(headerLine);
    if (header.length !== delimiter.length || header.length === 0) {
        return null;
    }

    const tableLines = [headerLine, delimiterLine];
    let cursor = index + 2;

    while (cursor < lines.length && isPotentialTableRow(lines[cursor])) {
        const cells = splitTableRow(lines[cursor]);
        if (cells.length === 0) {
            break;
        }

        tableLines.push(lines[cursor]);
        cursor += 1;
    }

    return {
        block: { type: "table", text: formatMarkdownTableSource(tableLines.join("\n")) },
        consumedLines: tableLines.length,
    };
}

export function formatMarkdownTableSource(text: string): string {
    const table = parseMarkdownTable(text);
    if (!table) {
        return text;
    }

    const rows = [table.header, ...table.rows].map((row) =>
        table.alignments.map((_, index) => (row[index] ?? "").trim()),
    );
    const widths = table.alignments.map((alignment, columnIndex) => {
        const contentWidth = rows.reduce((width, row) => Math.max(width, row[columnIndex]?.length ?? 0), 0);
        return Math.max(contentWidth, readDelimiterWidth(alignment));
    });

    return [
        serializeAlignedTableRow(table.header, widths, table.alignments),
        serializeTableDelimiterRow(table.alignments, widths),
        ...table.rows.map((row) => serializeAlignedTableRow(row, widths, table.alignments)),
    ].join("\n");
}

export function readMarkdownTableCellRange(
    text: string,
    lineIndex: number,
    cellIndex: number,
): { start: number; end: number } | null {
    const lines = text.split("\n");
    if (lineIndex < 0 || lineIndex >= lines.length) {
        return null;
    }

    const lineStart = lines.slice(0, lineIndex).join("\n").length + (lineIndex > 0 ? 1 : 0);
    const cells = readMarkdownTableRowCellRanges(lines[lineIndex], lineStart);
    return cells[cellIndex] ?? null;
}

export function readMarkdownTableCellFocusOffset(text: string, lineIndex: number, cellIndex: number): number | null {
    const range = readMarkdownTableCellRange(text, lineIndex, cellIndex);
    if (!range) {
        return null;
    }

    const alignment = parseMarkdownTable(text)?.alignments[cellIndex] ?? null;
    return lineIndex !== 1 && alignment === "right" ? range.end : range.start;
}

export function readMarkdownTableCellAtOffset(text: string, offset: number): MarkdownTableCellBoundary | null {
    const lines = text.split("\n");
    let lineStart = 0;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        const lineEnd = lineStart + line.length;
        if (offset >= lineStart && offset <= lineEnd) {
            const cells = readMarkdownTableRowCellRanges(line, lineStart).map((range, cellIndex) => ({
                lineIndex,
                cellIndex,
                ...range,
            }));
            return cells.find((cell) => offset <= cell.end) ?? cells[cells.length - 1] ?? null;
        }

        lineStart = lineEnd + 1;
    }

    return null;
}

export function readMarkdownTableColumnCount(text: string): number {
    const header = text.split("\n")[0] ?? "";
    return readMarkdownTableRowCellRanges(header, 0).length;
}

export function createEmptyMarkdownTableRow(columnCount: number): string {
    return serializeTableRow(Array.from({ length: columnCount }, () => ""));
}

export function renderMarkdownBlock(
    type: BlockType,
    text: string,
    context: DocumentRenderContext,
    renderInline: (text: string, context: DocumentRenderContext) => string,
): string | null {
    if (type === "math") {
        return renderLatexMath(text, true);
    }

    if (type === "html") {
        return renderMarkdownHtmlBlock(text);
    }

    if (type !== "table") {
        return null;
    }

    const table = parseMarkdownTable(text);
    if (!table) {
        return `<pre class="markdown-table-fallback">${escapeHtml(text)}</pre>`;
    }

    const header = table.header
        .map((cell, index) => renderTableCell("th", cell, table.alignments[index], 0, index, text, context, renderInline))
        .join("");
    const rows = table.rows
        .map((row, rowIndex) => {
            const cells = table.alignments
                .map((alignment, index) => renderTableCell(
                    "td",
                    row[index] ?? "",
                    alignment,
                    rowIndex + 2,
                    index,
                    text,
                    context,
                    renderInline,
                ))
                .join("");
            return `<tr>${cells}</tr>`;
        })
        .join("");

    return `<table class="markdown-table"><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>`;
}

function parseMarkdownTable(text: string): ParsedMarkdownTable | null {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    if (lines.length < 2) {
        return null;
    }

    const alignments = parseTableDelimiterRow(lines[1]);
    if (!alignments) {
        return null;
    }

    const header = splitTableRow(lines[0]);
    if (header.length !== alignments.length) {
        return null;
    }

    return {
        alignments,
        header,
        rows: lines.slice(2).filter(isPotentialTableRow).map(splitTableRow),
    };
}

function renderTableCell(
    tag: "th" | "td",
    text: string,
    alignment: TableAlignment,
    rowIndex: number,
    columnIndex: number,
    source: string,
    context: DocumentRenderContext,
    renderInline: (text: string, context: DocumentRenderContext) => string,
): string {
    const align = alignment ? ` style="text-align: ${alignment}"` : "";
    const sourceOffset = readMarkdownTableCellFocusOffset(source, rowIndex, columnIndex);
    const offset = sourceOffset === null ? "" : ` data-atomic-source-offset="${sourceOffset}"`;
    return `<${tag}${align} data-table-source-row="${rowIndex}" data-table-source-column="${columnIndex}"${offset}>${renderInline(text.trim(), context)}</${tag}>`;
}

function parseTableDelimiterRow(line: string): TableAlignment[] | null {
    if (!isPotentialTableRow(line)) {
        return null;
    }

    const cells = splitTableRow(line);
    if (cells.length === 0) {
        return null;
    }

    const alignments: TableAlignment[] = [];
    const delimiterPattern = /^:?-{1,}:?$/;
    for (const cell of cells) {
        const trimmed = cell.trim();
        if (!delimiterPattern.test(trimmed)) {
            return null;
        }

        alignments.push(readAlignment(trimmed));
    }

    return alignments;
}

function readAlignment(delimiter: string): TableAlignment {
    const left = delimiter.startsWith(":");
    const right = delimiter.endsWith(":");

    if (left && right) {
        return "center";
    }

    if (right) {
        return "right";
    }

    if (left) {
        return "left";
    }

    return null;
}

function readDelimiterWidth(alignment: TableAlignment): number {
    return alignment === "center" ? 5 : alignment ? 4 : 3;
}

function isPotentialTableRow(line: string | undefined): line is string {
    return Boolean(line && line.trim() !== "" && line.includes("|"));
}

function splitTableRow(line: string): string[] {
    return readMarkdownTableRowCellRanges(line, 0).map(({ start, end }) => line.slice(start, end));
}

function countRun(text: string, index: number, character: string): number {
    let length = 0;

    while (text[index + length] === character) {
        length += 1;
    }

    return length;
}

function serializeTableRow(cells: string[]): string {
    return `| ${cells.join(" | ")} |`;
}

function serializeAlignedTableRow(cells: string[], widths: number[], alignments: TableAlignment[]): string {
    const values = widths.map((width, index) => alignTableCell(cells[index] ?? "", width, alignments[index]));
    return serializeTableRow(values);
}

function serializeTableDelimiterRow(alignments: TableAlignment[], widths: number[]): string {
    return serializeTableRow(widths.map((width, index) => createDelimiterCell(alignments[index], width)));
}

function alignTableCell(cell: string, width: number, alignment: TableAlignment): string {
    const trimmed = cell.trim();
    if (alignment === "right") {
        return trimmed.padStart(width, " ");
    }

    if (alignment === "center") {
        const left = Math.floor((width - trimmed.length) / 2);
        const right = Math.max(0, width - trimmed.length - left);
        return `${" ".repeat(Math.max(0, left))}${trimmed}${" ".repeat(right)}`;
    }

    return trimmed.padEnd(width, " ");
}

function createDelimiterCell(alignment: TableAlignment, width: number): string {
    if (alignment === "center") {
        return `:${"-".repeat(Math.max(3, width - 2))}:`;
    }

    if (alignment === "right") {
        return `${"-".repeat(Math.max(3, width - 1))}:`;
    }

    if (alignment === "left") {
        return `:${"-".repeat(Math.max(3, width - 1))}`;
    }

    return "-".repeat(Math.max(3, width));
}

export function readMarkdownTableRowCellRanges(line: string, lineStart: number): Array<{ start: number; end: number }> {
    const ranges: Array<{ start: number; end: number }> = [];
    const first = line.search(/\S/);
    const leadingPipe = first >= 0 && line[first] === "|";
    let cellStart = leadingPipe ? first + 1 : 0;
    let trailingPipe = false;

    for (const index of [...readTableSeparators(line).filter(index => index >= cellStart), line.length]) {
        const rawCell = line.slice(cellStart, index);
        let start = cellStart;
        let end = index;
        if (rawCell.trim() === "") {
            start += rawCell.startsWith(" ") ? 1 : 0;
            end -= rawCell.endsWith(" ") ? 1 : 0;
            end = Math.max(start, end);
        } else {
            while (start < end && /\s/.test(line[start])) {
                start += 1;
            }
            while (end > start && /\s/.test(line[end - 1])) {
                end -= 1;
            }
        }
        ranges.push({ start: lineStart + start, end: lineStart + end });
        if (index < line.length) trailingPipe = line.slice(index + 1).trim() === "";
        cellStart = index + 1;
    }

    if (trailingPipe && ranges.length > 1) {
        ranges.pop();
    }

    return ranges;
}

/** Cell inputs edit Markdown source. Escape only pipes that would split a row. */
export function escapeMarkdownTableCell(value: string): string {
    const line = value.replace(/\r\n?|\n/g, " ");
    const separators = new Set(readTableSeparators(line));
    return line.split("").map((character, index) => separators.has(index) ? `\\${character}` : character).join("");
}

// A pipe separates cells iff it has even escape parity and is outside a
// matched code span. Unmatched backticks remain literal source characters.
function readTableSeparators(line: string): number[] {
    const separators: number[] = [];
    for (let index = 0; index < line.length; index += 1) {
        if (line[index] === "`" && !isEscapedAt(line, index)) {
            const length = countRun(line, index, "`");
            let closing = index + length;
            while (closing < line.length) {
                closing = line.indexOf("`", closing);
                if (closing < 0) break;
                const run = countRun(line, closing, "`");
                if (run === length) break;
                closing += run;
            }
            index = closing >= 0 && closing < line.length ? closing + length - 1 : index + length - 1;
        } else if (line[index] === "|" && !isEscapedAt(line, index)) {
            separators.push(index);
        }
    }
    return separators;
}
