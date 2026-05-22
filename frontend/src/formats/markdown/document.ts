import { headingTypes, type BlockType, type ParsedBlock, type ParsedDocument } from "../../editor/blocks/model";
import { titleFromFileName } from "../file-names";
import type { DocumentFileLike, DocumentFormat, DocumentReferenceMap } from "../types";
import { hasMarkdownBlockSource, readMarkdownBlockSource } from "./block-source";
import { createCodeFence } from "./code-fence";
import { hydrateMarkdownImagePreviews } from "./images";
import { renderInlineMarkdown } from "./inline";
import { parseMarkdownReferenceDefinition } from "./references";
import { readMarkdownTable, renderMarkdownBlock } from "./table";

export const markdownDocumentFormat: DocumentFormat = {
    id: "markdown",
    label: "Markdown",
    extensions: ["md", "markdown"],
    defaultExtension: "md",
    defaultFileName: "Untitled.md",
    supportsTitle: true,
    parseDocument: parseMarkdownDocument,
    parseFragment: parseMarkdownFragment,
    serializeDocument: serializeMarkdownDocument,
    readReferences: readMarkdownReferences,
    hasBlockSource: hasMarkdownBlockSource,
    readBlockSource: readMarkdownBlockSource,
    renderInline: renderInlineMarkdown,
    renderBlock: (type, text, references) => renderMarkdownBlock(type, text, references, renderInlineMarkdown),
    hydrateRenderedContent: hydrateMarkdownImagePreviews,
};

function parseMarkdownDocument(documentFile: DocumentFileLike): ParsedDocument {
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

        const referenceDefinition = parseMarkdownReferenceDefinition(line);
        if (referenceDefinition) {
            references[referenceDefinition.normalizedLabel] = referenceDefinition.reference;
            blocks.push({ type: "reference", text: line });
            continue;
        }

        const mathBlock = readMathBlock(lines, index);
        if (mathBlock) {
            blocks.push(mathBlock.block);
            index += mathBlock.consumedLines - 1;
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

    return { blocks, references };
}

function serializeMarkdownDocument(title: string, usesTitle: boolean, blocks: ParsedBlock[]): string {
    const trimmedTitle = title.trim();
    const body = blocks.map(serializeMarkdownBlock).join("\n");
    const content = usesTitle && trimmedTitle ? `# ${trimmedTitle}${body ? `\n\n${body}` : ""}` : body;

    return content ? `${content}\n` : "";
}

function readMarkdownReferences(blocks: ParsedBlock[]): DocumentReferenceMap {
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

function parseMarkdownLine(line: string): ParsedBlock {
    const headingMatch = line.match(/^ {0,3}(#{1,6})\s+(.*)$/);
    if (headingMatch) {
        return {
            type: `heading-${headingMatch[1].length}` as BlockType,
            text: headingMatch[2].replace(/\s+#+\s*$/, ""),
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

function serializeMarkdownBlock(block: ParsedBlock): string {
    if (headingTypes.has(block.type)) {
        return `${"#".repeat(Number(block.type.slice("heading-".length)))} ${block.text}`;
    }

    if (block.type === "list") {
        return `${serializeListIndent(block.indent)}${block.listMarker ?? "-"} ${block.text}`;
    }

    if (block.type === "ordered-list") {
        return `${serializeListIndent(block.indent)}${block.listNumber ?? "1"}. ${block.text}`;
    }

    if (block.type === "todo") {
        return `${serializeListIndent(block.indent)}${block.listMarker ?? "-"} [${block.checked ? "x" : " "}] ${block.text}`;
    }

    if (block.type === "quote") {
        const marker = ">".repeat(Math.max(1, block.quoteLevel ?? 1));
        return block.text
            .split("\n")
            .map((line) => (line ? `${marker} ${line}` : marker))
            .join("\n");
    }

    if (block.type === "code") {
        const fence = createCodeFence(block.text, block.codeFence);
        const codeInfo = block.codeInfo ? ` ${block.codeInfo}` : "";
        const code = `${block.text}\n`;

        return `${fence}${codeInfo}\n${code}${fence}`;
    }

    if (block.type === "rule") {
        return block.ruleMarker ?? "---";
    }

    if (block.type === "table") {
        return block.text;
    }

    if (block.type === "math") {
        return block.mathSource ?? `$$\n${block.text}\n$$`;
    }

    return block.text;
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
        return { block: { type: "heading-1", text: line.trim() } };
    }

    if (isSetextHeadingUnderline(underline, "-")) {
        return { block: { type: "heading-2", text: line.trim() } };
    }

    return null;
}

function isPlainParagraphLine(line: string): boolean {
    return (
        line.trim() !== "" &&
        !readCodeFence(line) &&
        !isIndentedCodeLine(line, null) &&
        !parseMarkdownReferenceDefinition(line) &&
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

function serializeListIndent(indent: number | undefined): string {
    return "  ".repeat(Math.max(0, Math.min(indent ?? 0, 3)));
}

function countIndentColumns(value: string): number {
    let columns = 0;

    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];

        if (character === "\t") {
            columns += 4 - (columns % 4);
        } else {
            columns += 1;
        }
    }

    return columns;
}

function readCodeFence(line: string): { marker: string; info: string } | null {
    const match = line.trim().match(/^(`{3,}|~{3,})(.*)$/);
    if (!match) {
        return null;
    }

    return {
        marker: match[1],
        info: match[2].trim(),
    };
}

function isClosingCodeFence(line: string, fence: string): boolean {
    const trimmed = line.trim();
    const fenceCharacter = fence[0];

    return trimmed.startsWith(fenceCharacter.repeat(fence.length)) && trimmed.split("").every((char) => char === fenceCharacter);
}
