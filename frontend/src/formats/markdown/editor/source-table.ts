import { readMarkdownTableRowCellRanges } from "../table";

export type TableCellBoundary = {
    lineIndex: number;
    cellIndex: number;
    start: number;
    end: number;
};

export function readTableCellBoundary(text: string, lineIndex: number, cellIndex: number): TableCellBoundary | null {
    const lines = text.split("\n");
    if (lineIndex < 0 || lineIndex >= lines.length) {
        return null;
    }

    const lineStart = lines.slice(0, lineIndex).join("\n").length + (lineIndex > 0 ? 1 : 0);
    return readTableRowCellBoundaries(lines[lineIndex], lineStart, lineIndex)[cellIndex] ?? null;
}

export function readTableRowCellBoundaries(line: string, lineStart: number, lineIndex: number): TableCellBoundary[] {
    return readMarkdownTableRowCellRanges(line, lineStart).map((range, cellIndex) => ({
        lineIndex,
        cellIndex,
        start: range.start,
        end: range.end,
    }));
}

export function readTableColumnCount(text: string): number {
    const header = text.split("\n")[0] ?? "";
    return readTableRowCellBoundaries(header, 0, 0).length;
}

export function createEmptyTableRow(columnCount: number): string {
    return `| ${Array.from({ length: columnCount }, () => "").join(" | ")} |`;
}

export function isEditableTableSource(rawMarkdown: string): boolean {
    const lines = rawMarkdown.replace(/\r\n?/g, "\n").split("\n");
    return lines.length >= 2 && lines[0].includes("|") && lines[1].includes("|");
}
