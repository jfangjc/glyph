import { headingTypes, type BlockType, type ParsedBlock, type ParsedDocument } from "../../editor/blocks/model";
import { titleFromFileName } from "../file-names";
import type { DocumentFileLike, DocumentFormat, DocumentReferenceMap, DocumentRenderContext } from "../types";
import { hasMarkdownBlockSource, readMarkdownBlockSource } from "./block-source";
import { createCodeFence } from "./code-fence";
import { isMarkdownHtmlBlockStart, readMarkdownHtmlBlock } from "./html";
import { hydrateMarkdownImagePreviews } from "./images";
import { renderInlineMarkdown } from "./inline";
import { normalizeReferenceLabel, parseMarkdownReferenceDefinition } from "./references";
import { readMarkdownTable, renderMarkdownBlock } from "./table";
import { markdownEditorBehavior } from "./editor/behavior";
import { countIndentColumns, serializeListIndent } from "./utils";
import { escapeHtml } from "../../utils/text";

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
    readRenderContext: readMarkdownRenderContext,
    applyRenderContext: applyMarkdownRenderContext,
    renderDocumentFooter: renderMarkdownDocumentFooter,
    hasBlockSource: hasMarkdownBlockSource,
    readBlockSource: readMarkdownBlockSource,
    renderInline: renderInlineMarkdown,
    renderBlock: (type, text, context) => renderMarkdownBlock(type, text, context, renderInlineMarkdown) ?? renderExtendedMarkdownBlock(type, text, context),
    hydrateRenderedContent: hydrateMarkdownImagePreviews,
    editorBehavior: markdownEditorBehavior,
    clipboardMimeTypes: ["text/markdown"],
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

        const footnoteDefinition = readFootnoteDefinition(lines, index);
        if (footnoteDefinition) {
            blocks.push(footnoteDefinition.block);
            index += footnoteDefinition.consumedLines - 1;
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

        const definitionList = readDefinitionList(lines, index);
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

function serializeMarkdownDocument(_title: string, _usesTitle: boolean, blocks: ParsedBlock[]): string {
    const body = blocks.map(serializeMarkdownBlock).join("\n");

    return body ? `${body}\n` : "";
}

type MarkdownRenderData = {
    headingIds: string[];
    footnotes: {
        definitions: Record<string, { label: string; text: string }>;
        numbers: Record<string, number>;
        order: string[];
    };
};

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

function readMarkdownRenderContext(blocks: ParsedBlock[]): DocumentRenderContext {
    const references = readMarkdownReferences(blocks);
    const data: MarkdownRenderData = {
        headingIds: readMarkdownHeadingIds(blocks),
        footnotes: readMarkdownFootnotes(blocks),
    };

    return { references, data };
}

function applyMarkdownRenderContext(blocks: HTMLElement[], context: DocumentRenderContext): void {
    const data = readMarkdownRenderData(context);
    if (!data) {
        return;
    }

    let headingIndex = 0;
    for (const block of blocks) {
        const type = block.dataset.type as BlockType | undefined;
        if (!type || !headingTypes.has(type)) {
            block.removeAttribute("id");
            continue;
        }

        const headingId = data.headingIds[headingIndex];
        headingIndex += 1;
        if (headingId) {
            block.dataset.headingId = headingId;
            if (block.dataset.headingIdExplicit !== "true") {
                block.dataset.headingIdExplicit = "false";
            }
            block.id = headingId;
        } else {
            delete block.dataset.headingId;
            delete block.dataset.headingIdExplicit;
            block.removeAttribute("id");
        }
    }
}

function renderMarkdownDocumentFooter(context: DocumentRenderContext): string {
    const data = readMarkdownRenderData(context);
    if (!data || data.footnotes.order.length === 0) {
        return "";
    }

    const items = data.footnotes.order
        .map((label) => {
            const definition = data.footnotes.definitions[label];
            const number = data.footnotes.numbers[label];
            if (!definition || !number) {
                return "";
            }

            const encodedLabel = encodeURIComponent(label);
            return `<li id="fn-${encodedLabel}" class="markdown-footnote-item"><span class="markdown-footnote-body">${renderInlineMarkdown(definition.text, context)}</span> <a class="markdown-footnote-backref" href="#fnref-${encodedLabel}" data-href="#fnref-${encodedLabel}" aria-label="Back to reference">&#8617;</a></li>`;
        })
        .join("");

    return `<section class="markdown-footnotes"><hr><ol>${items}</ol></section>`;
}

function renderExtendedMarkdownBlock(type: BlockType, text: string, context: DocumentRenderContext): string | null {
    if (type !== "definition-list") {
        return null;
    }

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

function readMarkdownRenderData(context: DocumentRenderContext): MarkdownRenderData | null {
    const data = context.data;
    if (!data || typeof data !== "object" || !("headingIds" in data) || !("footnotes" in data)) {
        return null;
    }

    return data as MarkdownRenderData;
}


function createMarkdownSlugger(): { slug: (value: string) => string } {
    const counts = new Map<string, number>();

    return {
        slug(value: string): string {
            const base = slugMarkdownHeading(value);
            const count = counts.get(base) ?? 0;
            counts.set(base, count + 1);
            return count === 0 ? base : `${base}-${count}`;
        },
    };
}

function slugMarkdownHeading(value: string): string {
    const slug = value
        .trim()
        .toLowerCase()
        .replace(/<[^>]*>/g, "")
        .replace(/[\u{1F300}-\u{1FAFF}]/gu, "")
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .trim()
        .replace(/\s+/g, "-");

    return slug || "heading";
}

function readMarkdownHeadingIds(blocks: ParsedBlock[]): string[] {
    const slugger = createMarkdownSlugger();
    const ids: string[] = [];

    for (const block of blocks) {
        if (!headingTypes.has(block.type)) {
            continue;
        }

        const explicitId = block.headingIdExplicit ? normalizeHeadingId(block.headingId) : "";
        if (explicitId) {
            ids.push(explicitId);
            slugger.slug(explicitId);
            continue;
        }

        ids.push(slugger.slug(stripMarkdownInlineSource(block.text) || "heading"));
    }

    return ids;
}

function readMarkdownFootnotes(blocks: ParsedBlock[]): MarkdownRenderData["footnotes"] {
    const definitions: MarkdownRenderData["footnotes"]["definitions"] = {};
    const numbers: Record<string, number> = {};
    const order: string[] = [];

    for (const block of blocks) {
        if (block.type !== "footnote-definition") {
            continue;
        }

        const definition = parseFootnoteDefinitionSource(block.text);
        if (definition) {
            definitions[definition.normalizedLabel] = { label: definition.label, text: definition.text };
        }
    }

    for (const block of blocks) {
        if (block.type === "footnote-definition" || block.type === "reference" || block.type === "code" || block.type === "source") {
            continue;
        }

        for (const label of readFootnoteReferenceLabels(block.text)) {
            const normalizedLabel = normalizeReferenceLabel(label);
            if (!definitions[normalizedLabel] || numbers[normalizedLabel]) {
                continue;
            }

            numbers[normalizedLabel] = order.length + 1;
            order.push(normalizedLabel);
        }
    }

    return { definitions, numbers, order };
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

function serializeMarkdownBlock(block: ParsedBlock): string {
    if (headingTypes.has(block.type)) {
        const id = block.headingIdExplicit && block.headingId ? ` {#${block.headingId}}` : "";
        return `${"#".repeat(Number(block.type.slice("heading-".length)))} ${block.text}${id}`;
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

    if (block.type === "table" || block.type === "definition-list" || block.type === "footnote-definition") {
        return block.text;
    }

    if (block.type === "math") {
        return block.mathSource ?? `$$\n${block.text}\n$$`;
    }

    if (block.type === "html") {
        return block.text;
    }

    return block.text;
}


type DefinitionListItem = {
    terms: string[];
    definitions: string[];
};

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

function normalizeHeadingId(value: string | undefined): string {
    return (value ?? "").trim().replace(/\s+/g, "-");
}

function stripMarkdownInlineSource(value: string): string {
    return value
        .replace(/`([^`]*)`/g, "$1")
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[\\*_~=`^:[\](){}#!|>+-]/g, "")
        .trim();
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

function parseFootnoteDefinitionSource(value: string): { label: string; normalizedLabel: string; text: string } | null {
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

function isFootnoteContinuationLine(line: string): boolean {
    return line.trim() === "" || countIndentColumns(line.match(/^[ \t]*/)?.[0] ?? "") >= 4;
}

function readFootnoteReferenceLabels(text: string): string[] {
    const labels: string[] = [];
    const pattern = /\[\^([^\]\n]+)\]/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
        labels.push(match[1]);
    }

    return labels;
}

function readDefinitionList(lines: string[], index: number): { block: ParsedBlock; consumedLines: number } | null {
    if (!isDefinitionListStart(lines, index)) {
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

        if (seenDefinition && isDefinitionListStart(lines, cursor)) {
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

function isDefinitionListStart(lines: string[], index: number): boolean {
    return Boolean(
        lines[index] &&
            isPlainParagraphLine(lines[index]) &&
            lines[index + 1] &&
            isDefinitionMarkerLine(lines[index + 1]),
    );
}

function isDefinitionMarkerLine(line: string): boolean {
    return /^ {0,3}:\s+/.test(line);
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
