import type { BlockType, ParsedBlock } from "../../editor/blocks/model";
import type { DocumentReferenceMap } from "../types";
import { escapeHtml } from "../../utils/text";
import { renderLatexMath } from "./math";

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

export function createMarkdownTableFromHeader(headerLine: string): { text: string; firstBodyCellOffset: number } | null {
    if (!isPotentialTableRow(headerLine)) {
        return null;
    }

    const header = splitTableRow(headerLine).map((cell) => cell.trim());
    if (header.length < 2 || header.every((cell) => cell === "")) {
        return null;
    }

    const text = formatMarkdownTableSource([
        serializeTableRow(header),
        serializeTableRow(header.map(() => ":---")),
        serializeTableRow(header.map(() => "")),
    ].join("\n"));
    const firstBodyCellOffset = readMarkdownTableCellStart(text, 2, 0);

    return {
        text,
        firstBodyCellOffset: firstBodyCellOffset ?? text.length,
    };
}

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
    const table = parseMarkdownTable(text, { allowShortDelimiters: true });
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

export function readMarkdownTableCellStart(text: string, lineIndex: number, cellIndex: number): number | null {
    const lines = text.split("\n");
    if (lineIndex < 0 || lineIndex >= lines.length) {
        return null;
    }

    const lineStart = lines.slice(0, lineIndex).join("\n").length + (lineIndex > 0 ? 1 : 0);
    const cells = readTableRowCellRanges(lines[lineIndex], lineStart);
    return cells[cellIndex]?.start ?? null;
}

export function renderMarkdownBlock(
    type: BlockType,
    text: string,
    references: DocumentReferenceMap,
    renderInline: (text: string, references: DocumentReferenceMap) => string,
): string | null {
    if (type === "math") {
        return renderLatexMath(text, true);
    }

    if (type !== "table") {
        return null;
    }

    const table = parseMarkdownTable(text);
    if (!table) {
        return `<pre class="markdown-table-fallback">${escapeHtml(text)}</pre>`;
    }

    const header = table.header
        .map((cell, index) => renderTableCell("th", cell, table.alignments[index], references, renderInline))
        .join("");
    const rows = table.rows
        .map((row) => {
            const cells = table.alignments
                .map((alignment, index) => renderTableCell("td", row[index] ?? "", alignment, references, renderInline))
                .join("");
            return `<tr>${cells}</tr>`;
        })
        .join("");

    return `<table class="markdown-table"><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>`;
}

function parseMarkdownTable(
    text: string,
    options: { allowShortDelimiters?: boolean } = {},
): ParsedMarkdownTable | null {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    if (lines.length < 2) {
        return null;
    }

    const alignments = parseTableDelimiterRow(lines[1], options);
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
    references: DocumentReferenceMap,
    renderInline: (text: string, references: DocumentReferenceMap) => string,
): string {
    const align = alignment ? ` style="text-align: ${alignment}"` : "";
    return `<${tag}${align}>${renderInline(text.trim(), references)}</${tag}>`;
}

function parseTableDelimiterRow(
    line: string,
    options: { allowShortDelimiters?: boolean } = {},
): TableAlignment[] | null {
    if (!isPotentialTableRow(line)) {
        return null;
    }

    const cells = splitTableRow(line);
    if (cells.length === 0) {
        return null;
    }

    const alignments: TableAlignment[] = [];
    const delimiterPattern = options.allowShortDelimiters ? /^:?-{1,}:?$/ : /^:?-{3,}:?$/;
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

    return "left";
}

function readDelimiterWidth(alignment: TableAlignment): number {
    return alignment === "center" ? 5 : alignment ? 4 : 3;
}

function isPotentialTableRow(line: string | undefined): line is string {
    return Boolean(line && line.trim() !== "" && line.includes("|"));
}

function splitTableRow(line: string): string[] {
    let trimmed = line.trim();
    if (trimmed.startsWith("|")) {
        trimmed = trimmed.slice(1);
    }

    if (trimmed.endsWith("|") && !isEscapedAt(trimmed, trimmed.length - 1)) {
        trimmed = trimmed.slice(0, -1);
    }

    const cells: string[] = [];
    let cell = "";

    for (let index = 0; index < trimmed.length; index += 1) {
        const character = trimmed[index];
        if (character === "\\" && trimmed[index + 1] === "|") {
            cell += "|";
            index += 1;
            continue;
        }

        if (character === "|") {
            cells.push(cell);
            cell = "";
            continue;
        }

        cell += character;
    }

    cells.push(cell);
    return cells;
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

    return `:${"-".repeat(Math.max(3, width - 1))}`;
}

function readTableRowCellRanges(line: string, lineStart: number): Array<{ start: number; end: number }> {
    const ranges: Array<{ start: number; end: number }> = [];
    const leadingPipe = line.startsWith("|");
    let cellStart = leadingPipe ? 1 : 0;

    for (let index = cellStart; index <= line.length; index += 1) {
        if (index < line.length && (line[index] !== "|" || isEscapedAt(line, index))) {
            continue;
        }

        const rawCell = line.slice(cellStart, index);
        let start = cellStart;
        let end = index;
        if (rawCell.trim() === "") {
            start += rawCell.startsWith(" ") ? 1 : 0;
            end = start;
        } else {
            while (start < end && line[start] === " ") {
                start += 1;
            }
            while (end > start && line[end - 1] === " ") {
                end -= 1;
            }
        }
        ranges.push({ start: lineStart + start, end: lineStart + end });
        cellStart = index + 1;
    }

    if (leadingPipe && ranges.length > 0 && ranges[ranges.length - 1].start === lineStart + line.length) {
        ranges.pop();
    }

    return ranges;
}

function isEscapedAt(text: string, index: number): boolean {
    let slashCount = 0;

    for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
        slashCount += 1;
    }

    return slashCount % 2 === 1;
}
