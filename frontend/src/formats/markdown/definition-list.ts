import type { ParsedBlock } from "../../editor/blocks/model";
import type { DocumentRenderContext } from "../types";
import { escapeHtml } from "../../utils/text";
import { renderInlineMarkdown } from "./inline";
import { countIndentColumns } from "./utils";

type DefinitionListItem = {
    terms: string[];
    definitions: string[];
};

export function readDefinitionList(
    lines: string[],
    index: number,
    isPlainParagraphLine: (line: string) => boolean,
): { block: ParsedBlock; consumedLines: number } | null {
    if (!isDefinitionListStart(lines, index, isPlainParagraphLine)) {
        return null;
    }

    const listLines: string[] = [];
    let cursor = index;
    let seenDefinition = false;

    while (cursor < lines.length) {
        const line = lines[cursor];
        if (line.trim() === "") {
            break;
        }

        if (isDefinitionMarkerLine(line)) {
            seenDefinition = true;
            listLines.push(line);
            cursor += 1;
            while (cursor < lines.length && isDefinitionContinuationLine(lines[cursor])) {
                listLines.push(lines[cursor]);
                cursor += 1;
            }
            continue;
        }

        if (seenDefinition && isDefinitionListStart(lines, cursor, isPlainParagraphLine)) {
            listLines.push(line);
            cursor += 1;
            continue;
        }

        if (!seenDefinition) {
            listLines.push(line);
            cursor += 1;
            continue;
        }

        break;
    }

    if (!seenDefinition) {
        return null;
    }

    return {
        block: { type: "definition-list", text: listLines.join("\n") },
        consumedLines: listLines.length,
    };
}

export function renderDefinitionListBlock(text: string, context: DocumentRenderContext): string {
    const items = parseDefinitionListSource(text);
    if (items.length === 0) {
        return `<pre class="markdown-definition-list-fallback">${escapeHtml(text)}</pre>`;
    }

    const html = items
        .map((item) => {
            const terms = item.terms
                .map((term) => `<dt>${renderInlineMarkdown(term.trim(), context)}</dt>`)
                .join("");
            const definitions = item.definitions
                .map((definition) => `<dd>${renderInlineMarkdown(definition.trim(), context)}</dd>`)
                .join("");
            return `${terms}${definitions}`;
        })
        .join("");

    return `<dl class="markdown-definition-list">${html}</dl>`;
}

export function isDefinitionMarkerLine(line: string): boolean {
    return /^ {0,3}:\s+/.test(line);
}

function isDefinitionListStart(
    lines: string[],
    index: number,
    isPlainParagraphLine: (line: string) => boolean,
): boolean {
    return Boolean(
        lines[index] &&
            isPlainParagraphLine(lines[index]) &&
            lines[index + 1] &&
            isDefinitionMarkerLine(lines[index + 1]),
    );
}

function isDefinitionContinuationLine(line: string): boolean {
    return line.trim() === "" || countIndentColumns(line.match(/^[ \t]*/)?.[0] ?? "") >= 4;
}

function parseDefinitionListSource(text: string): DefinitionListItem[] {
    const items: DefinitionListItem[] = [];
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    let terms: string[] = [];
    let current: DefinitionListItem | null = null;

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const definitionMatch = line.match(/^ {0,3}:\s+(.*)$/);
        if (definitionMatch) {
            if (!current) {
                current = { terms: terms.splice(0), definitions: [] };
                items.push(current);
            }

            current.definitions.push(readDefinitionListDefinition(lines, index, definitionMatch[1]));
            while (index + 1 < lines.length && isDefinitionContinuationLine(lines[index + 1])) {
                index += 1;
            }
            continue;
        }

        if (line.trim()) {
            terms.push(line.trim());
            current = null;
        }
    }

    return items.filter((item) => item.terms.length > 0 && item.definitions.length > 0);
}

function readDefinitionListDefinition(lines: string[], index: number, firstLine: string): string {
    const values = [firstLine];
    let cursor = index + 1;
    while (cursor < lines.length && isDefinitionContinuationLine(lines[cursor])) {
        values.push(lines[cursor].replace(/^(?: {4}|\t)/, ""));
        cursor += 1;
    }

    return values.join("\n");
}
