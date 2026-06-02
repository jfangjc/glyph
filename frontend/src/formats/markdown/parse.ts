import { type BlockType, type ParsedBlock, type ParsedDocument } from "../../editor/blocks/model";
import { titleFromFileName } from "../file-names";
import type { DocumentFileLike, DocumentReferenceMap } from "../types";
import { isMarkdownHtmlBlockStart, readMarkdownHtmlBlock } from "./html";
import { normalizeReferenceLabel, parseMarkdownReferenceDefinition } from "./references";
import { readMarkdownTable } from "./table";
import { countIndentColumns, isEscapedAt } from "./utils";
import { isDefinitionMarkerLine, readDefinitionList } from "./definition-list";

export function parseMarkdownDocument(documentFile: DocumentFileLike): ParsedDocument {
    const lines = readMarkdownLines(documentFile.content, true);
    const parsed = parseMarkdownLines(lines, 0);

    return {
        title: titleFromFileName(documentFile.name),
        usesTitle: false,
        blocks: parsed.blocks.length > 0 ? parsed.blocks : [{ type: "paragraph", text: "" }],
        references: parsed.references,
    };
}

export function parseMarkdownFragment(content: string): { blocks: ParsedBlock[]; references: DocumentReferenceMap } {
    const parsed = parseMarkdownLines(readMarkdownLines(content, false), 0);

    return {
        blocks: parsed.blocks.length > 0 ? parsed.blocks : [{ type: "paragraph", text: "" }],
        references: parsed.references,
    };
}

export function readMarkdownReferences(blocks: ParsedBlock[]): DocumentReferenceMap {
    const references: DocumentReferenceMap = {};

    for (const block of blocks) {
        if (block.type !== "reference") {
            continue;
        }

        const definition = parseMarkdownReferenceDefinition(block.text);
        if (definition) {
            references[definition.normalizedLabel] = definition.reference;
        }
    }

    return references;
}

export function stripMarkdownInlineSource(value: string): string {
    return value
        .replace(/`([^`]*)`/g, "$1")
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[\\*_~=`^:[\](){}#!|>+-]/g, "")
        .trim();
}

export function normalizeHeadingId(value: string | undefined): string {
    return (value ?? "").trim().replace(/\s+/g, "-");
}

export function parseFootnoteDefinitionSource(value: string): { label: string; normalizedLabel: string; text: string } | null {
    const match = value.match(/^ {0,3}\[\^([^\]]+)\]:\s?(.*)$/s);
    if (!match) {
        return null;
    }

    const label = match[1];
    const normalizedLabel = normalizeReferenceLabel(label);
    if (!normalizedLabel) {
        return null;
    }

    const lines = value.replace(/\r\n?/g, "\n").split("\n");
    const first = lines[0].replace(/^ {0,3}\[\^[^\]]+\]:\s?/, "");
    const rest = lines.slice(1).map((line) => line.replace(/^(?: {4}|\t)/, ""));
    return {
        label,
        normalizedLabel,
        text: [first, ...rest].join("\n").trim(),
    };
}

export function readFootnoteReferenceLabels(text: string): string[] {
    const labels: string[] = [];
    const pattern = /\[\^([^\]\n]+)\]/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
        if (isEscapedAt(text, match.index) || isInsideInlineCodeSpan(text, match.index)) {
            continue;
        }

        labels.push(match[1]);
    }

    return labels;
}

function readMarkdownLines(content: string, trimTrailingEmptyLine: boolean): string[] {
    const lines = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");

    if (trimTrailingEmptyLine && lines.length > 1 && lines[lines.length - 1] === "") {
        lines.pop();
    }

    return lines;
}

function parseMarkdownLines(lines: string[], startLine: number): { blocks: ParsedBlock[]; references: DocumentReferenceMap } {
    const blocks: ParsedBlock[] = [];
    const references: DocumentReferenceMap = {};

    for (let index = startLine; index < lines.length; index += 1) {
        const line = lines[index];
        const fence = readCodeFence(line);

        if (fence) {
            const codeLines: string[] = [];
            index += 1;

            while (index < lines.length && !isClosingCodeFence(lines[index], fence.marker)) {
                codeLines.push(lines[index]);
                index += 1;
            }

            blocks.push({ type: "code", text: codeLines.join("\n"), codeFence: fence.marker, codeInfo: fence.info });
            continue;
        }

        if (isIndentedCodeLine(line, getPreviousNonBlankBlock(blocks))) {
            const codeLines = [stripCodeIndent(line)];
            index += 1;

            while (index < lines.length && (lines[index] === "" || isIndentedCodeContinuationLine(lines[index]))) {
                codeLines.push(lines[index] === "" ? "" : stripCodeIndent(lines[index]));
                index += 1;
            }

            index -= 1;
            blocks.push({ type: "code", text: codeLines.join("\n") });
            continue;
        }

        const footnoteDefinition = readFootnoteDefinition(lines, index);
        if (footnoteDefinition) {
            blocks.push(footnoteDefinition.block);
            index += footnoteDefinition.consumedLines - 1;
            continue;
        }

        const referenceDefinition = readReferenceDefinition(lines, index);
        if (referenceDefinition) {
            references[referenceDefinition.normalizedLabel] = referenceDefinition.reference;
            blocks.push({ type: "reference", text: referenceDefinition.text });
            index += referenceDefinition.consumedLines - 1;
            continue;
        }

        const mathBlock = readMathBlock(lines, index);
        if (mathBlock) {
            blocks.push(mathBlock.block);
            index += mathBlock.consumedLines - 1;
            continue;
        }

        const htmlBlock = readMarkdownHtmlBlock(lines, index);
        if (htmlBlock) {
            blocks.push(htmlBlock.block);
            index += htmlBlock.consumedLines - 1;
            continue;
        }

        const setextHeading = readSetextHeading(lines, index);
        if (setextHeading) {
            blocks.push(setextHeading.block);
            index += 1;
            continue;
        }

        const table = readMarkdownTable(lines, index);
        if (table) {
            blocks.push(table.block);
            index += table.consumedLines - 1;
            continue;
        }

        const definitionList = readDefinitionList(lines, index, isPlainParagraphLine);
        if (definitionList) {
            blocks.push(definitionList.block);
            index += definitionList.consumedLines - 1;
            continue;
        }

        const hardBreakParagraph = readHardBreakParagraph(lines, index);
        if (hardBreakParagraph) {
            blocks.push(hardBreakParagraph.block);
            index += hardBreakParagraph.consumedLines - 1;
            continue;
        }

        const horizontalRule = readHorizontalRuleMarker(line);
        if (horizontalRule) {
            blocks.push({ type: "rule", text: "", ruleMarker: horizontalRule });
            continue;
        }

        blocks.push(parseMarkdownLine(line));
    }

    normalizeOrderedListNumbers(blocks);
    return { blocks, references };
}

function readReferenceDefinition(
    lines: string[],
    index: number,
): { normalizedLabel: string; reference: DocumentReferenceMap[string]; text: string; consumedLines: number } | null {
    const line = lines[index];
    const nextLine = lines[index + 1];

    if (nextLine !== undefined && isReferenceTitleContinuationLine(nextLine)) {
        const multilineText = `${line}\n${nextLine}`;
        const multiline = parseMarkdownReferenceDefinition(multilineText);
        if (multiline) {
            return { ...multiline, text: multilineText, consumedLines: 2 };
        }
    }

    const singleLine = parseMarkdownReferenceDefinition(line);
    return singleLine ? { ...singleLine, text: line, consumedLines: 1 } : null;
}

function isReferenceTitleContinuationLine(line: string): boolean {
    return /^ {0,3}(?:"[^"]*"|'[^']*'|\([^)]*\))\s*$/.test(line);
}

function parseMarkdownLine(line: string): ParsedBlock {
    const headingMatch = line.match(/^ {0,3}(#{1,6})\s+(.*)$/);
    if (headingMatch) {
        const heading = readHeadingTextAndId(headingMatch[2].replace(/\s+#+\s*$/, ""));
        return {
            type: `heading-${headingMatch[1].length}` as BlockType,
            text: heading.text,
            headingId: heading.id,
            headingIdExplicit: Boolean(heading.id),
        };
    }

    const todoMatch = line.match(/^([ \t]*)([-*+])\s+\[([ xX])\]\s?(.*)$/);
    if (todoMatch) {
        return {
            type: "todo",
            text: todoMatch[4],
            checked: todoMatch[3].toLowerCase() === "x",
            indent: readMarkdownIndent(todoMatch[1]),
            listMarker: todoMatch[2],
        };
    }

    const orderedListMatch = line.match(/^([ \t]*)(\d{1,9})\.\s+(.*)$/);
    if (orderedListMatch) {
        return {
            type: "ordered-list",
            text: orderedListMatch[3],
            indent: readMarkdownIndent(orderedListMatch[1]),
            listNumber: orderedListMatch[2],
        };
    }

    const listMatch = line.match(/^([ \t]*)([-*+])\s+(.*)$/);
    if (listMatch) {
        return {
            type: "list",
            text: listMatch[3],
            indent: readMarkdownIndent(listMatch[1]),
            listMarker: listMatch[2],
        };
    }

    const quoteMatch = line.match(/^[ \t]*(>+)\s?(.*)$/);
    if (quoteMatch) {
        return { type: "quote", text: quoteMatch[2], quoteLevel: quoteMatch[1].length };
    }

    return { type: "paragraph", text: line };
}

function normalizeOrderedListNumbers(blocks: ParsedBlock[]): void {
    const nextByIndent = new Map<number, number>();

    for (const block of blocks) {
        if (block.type !== "ordered-list") {
            nextByIndent.clear();
            continue;
        }

        const indent = block.indent ?? 0;
        for (const trackedIndent of Array.from(nextByIndent.keys())) {
            if (trackedIndent > indent) {
                nextByIndent.delete(trackedIndent);
            }
        }

        const nextNumber = nextByIndent.get(indent) ?? readOrderedListStart(block.listNumber);
        block.listNumber = String(nextNumber);
        nextByIndent.set(indent, nextNumber + 1);
    }
}

function readOrderedListStart(value: string | undefined): number {
    const number = Number(value ?? "1");
    return Number.isFinite(number) ? number : 1;
}

function readHeadingTextAndId(value: string): { text: string; id?: string } {
    const match = value.match(/^(.*?)(?:\s+)?\{#([A-Za-z0-9_.:-]+)\}\s*$/);
    if (!match) {
        return { text: value.trim() };
    }

    return {
        text: match[1].trimEnd(),
        id: normalizeHeadingId(match[2]),
    };
}

function readFootnoteDefinition(lines: string[], index: number): { block: ParsedBlock; consumedLines: number } | null {
    const first = parseFootnoteDefinitionSource(lines[index]);
    if (!first) {
        return null;
    }

    const definitionLines = [lines[index]];
    let cursor = index + 1;
    while (cursor < lines.length && isFootnoteContinuationLine(lines[cursor])) {
        definitionLines.push(lines[cursor]);
        cursor += 1;
    }

    return {
        block: { type: "footnote-definition", text: definitionLines.join("\n") },
        consumedLines: definitionLines.length,
    };
}

function isFootnoteContinuationLine(line: string): boolean {
    return line.trim() === "" || countIndentColumns(line.match(/^[ \t]*/)?.[0] ?? "") >= 4;
}

function isInsideInlineCodeSpan(text: string, offset: number): boolean {
    let markerLength = 0;

    for (let index = 0; index < offset; index += 1) {
        if (text[index] !== "`" || isEscapedAt(text, index)) {
            continue;
        }

        const length = countCharacterRun(text, index, "`");
        if (markerLength === 0) {
            markerLength = length;
        } else if (markerLength === length) {
            markerLength = 0;
        }
        index += length - 1;
    }

    return markerLength > 0;
}

function countCharacterRun(text: string, index: number, character: string): number {
    let length = 0;

    while (text[index + length] === character) {
        length += 1;
    }

    return length;
}

function readMathBlock(lines: string[], index: number): { block: ParsedBlock; consumedLines: number } | null {
    const line = lines[index];
    const singleLineMatch = line.match(/^ {0,3}\$\$(.*?)\$\$\s*$/);
    if (singleLineMatch) {
        return {
            block: { type: "math", text: singleLineMatch[1], mathSource: line },
            consumedLines: 1,
        };
    }

    if (!line.match(/^ {0,3}\$\$\s*$/)) {
        return null;
    }

    const mathLines: string[] = [];
    let cursor = index + 1;

    while (cursor < lines.length && !lines[cursor].match(/^ {0,3}\$\$\s*$/)) {
        mathLines.push(lines[cursor]);
        cursor += 1;
    }

    return {
        block: {
            type: "math",
            text: mathLines.join("\n"),
            mathSource: cursor < lines.length ? lines.slice(index, cursor + 1).join("\n") : undefined,
        },
        consumedLines: cursor < lines.length ? cursor - index + 1 : cursor - index,
    };
}

function readHardBreakParagraph(lines: string[], index: number): { block: ParsedBlock; consumedLines: number } | null {
    const firstLine = lines[index];
    if (!hasHardLineBreak(firstLine) || !isPlainParagraphLine(firstLine)) {
        return null;
    }

    const paragraphLines = [firstLine];
    let cursor = index + 1;

    while (
        cursor < lines.length &&
        isPlainParagraphLine(lines[cursor]) &&
        hasHardLineBreak(paragraphLines[paragraphLines.length - 1])
    ) {
        paragraphLines.push(lines[cursor]);
        cursor += 1;
    }

    return {
        block: { type: "paragraph", text: paragraphLines.join("\n") },
        consumedLines: paragraphLines.length,
    };
}

function hasHardLineBreak(line: string | undefined): boolean {
    return Boolean(line?.match(/(?: {2,}|\\)$/));
}

function readSetextHeading(lines: string[], index: number): { block: ParsedBlock } | null {
    const line = lines[index];
    const underline = lines[index + 1];

    if (!line || !isPlainParagraphLine(line)) {
        return null;
    }

    if (isSetextHeadingUnderline(underline, "=")) {
        const heading = readHeadingTextAndId(line.trim());
        return { block: { type: "heading-1", text: heading.text, headingId: heading.id, headingIdExplicit: Boolean(heading.id) } };
    }

    if (isSetextHeadingUnderline(underline, "-")) {
        const heading = readHeadingTextAndId(line.trim());
        return { block: { type: "heading-2", text: heading.text, headingId: heading.id, headingIdExplicit: Boolean(heading.id) } };
    }

    return null;
}

function isPlainParagraphLine(line: string): boolean {
    return (
        line.trim() !== "" &&
        !readCodeFence(line) &&
        !isIndentedCodeLine(line, null) &&
        !isMarkdownHtmlBlockStart(line) &&
        !parseMarkdownReferenceDefinition(line) &&
        !parseFootnoteDefinitionSource(line) &&
        !isDefinitionMarkerLine(line) &&
        !isHorizontalRule(line) &&
        parseMarkdownLine(line).type === "paragraph"
    );
}

function isSetextHeadingUnderline(line: string | undefined, marker: "=" | "-"): boolean {
    if (line === undefined) {
        return false;
    }

    const trimmed = line.trim();
    return trimmed.length > 0 && trimmed.split("").every((character) => character === marker);
}

function isHorizontalRule(line: string): boolean {
    return readHorizontalRuleMarker(line) !== null;
}

function readHorizontalRuleMarker(line: string): string | null {
    const trimmed = line.trim();

    return /^(\*\s*){3,}$/.test(trimmed) || /^(-\s*){3,}$/.test(trimmed) || /^(_\s*){3,}$/.test(trimmed)
        ? trimmed
        : null;
}

function isIndentedCodeLine(line: string, previousBlock: ParsedBlock | null): boolean {
    if (line.trim() === "") {
        return false;
    }

    if (previousBlock?.type === "paragraph") {
        return false;
    }

    if (!isIndentedCodeContinuationLine(line)) {
        return false;
    }

    if (isNestedListCandidate(line)) {
        return false;
    }

    return true;
}

function isIndentedCodeContinuationLine(line: string): boolean {
    return line.trim() !== "" && countIndentColumns(line.match(/^[ \t]*/)?.[0] ?? "") >= 4;
}

function isNestedListCandidate(line: string): boolean {
    return Boolean(line.match(/^[ \t]*(?:[-*+]|\d{1,9}\.)\s+/));
}

function getPreviousNonBlankBlock(blocks: ParsedBlock[]): ParsedBlock | null {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
        if (blocks[index].text.trim() !== "") {
            return blocks[index];
        }
    }

    return null;
}

function stripCodeIndent(line: string): string {
    let columns = 0;

    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        const nextColumns = character === "\t" ? columns + 4 - (columns % 4) : columns + 1;

        if (character !== " " && character !== "\t") {
            return line.slice(index);
        }

        if (nextColumns >= 4) {
            return line.slice(index + 1);
        }

        columns = nextColumns;
    }

    return "";
}

function readMarkdownIndent(value: string): number {
    const columns = countIndentColumns(value);
    const level = Math.floor(columns / 2);

    return Math.min(Math.max(level, 0), 3);
}

function readCodeFence(line: string): { marker: string; info: string } | null {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!match) {
        return null;
    }

    return {
        marker: match[1],
        info: match[2].trim(),
    };
}

function isClosingCodeFence(line: string, fence: string): boolean {
    const fenceCharacter = fence[0];
    const match = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);

    return Boolean(match && match[1][0] === fenceCharacter && match[1].length >= fence.length);
}
