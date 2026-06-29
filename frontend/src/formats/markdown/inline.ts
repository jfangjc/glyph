import {
    normalizeReferenceLabel,
    parseMarkdownDestinationWithTitle,
    unescapeMarkdownText,
} from "./references";
import type { DocumentReferenceMap, DocumentRenderContext } from "../types";
import { escapeHtml } from "../../utils/text";
import { renderLatexMath } from "./math";
import { findUnescapedSequence, isEscapedAt } from "./utils";

type InlineToken = {
    raw: string;
    label: string;
    destination: string;
    title?: string;
};

type InlineCodeToken = {
    raw: string;
    code: string;
};

type MathToken = {
    raw: string;
    source: string;
    displayMode: boolean;
};

type EscapedCharacterToken = {
    raw: string;
    character: string;
};

type HardBreakToken = {
    raw: string;
};

type EmphasisToken = {
    raw: string;
    marker: "*" | "**" | "***" | "_" | "__" | "___";
    label: string;
    emphasis: boolean;
    strong: boolean;
};

type FormattingToken = {
    raw: string;
    marker: "~~" | "==" | "~" | "^";
    label: string;
};

type FootnoteReferenceToken = {
    raw: string;
    label: string;
    number: number;
    id: string;
};

type AutolinkToken = {
    raw: string;
    label: string;
    destination: string;
};

type MarkdownInlineToken = {
    raw: string;
};

const escapableCharacters = new Set(["\\", "`", "*", "_", "{", "}", "[", "]", "<", ">", "(", ")", "#", "+", "-", ".", "!", "|", "$", "~", "=", "^", ":"]);

export function renderInlineMarkdown(
    text: string,
    contextOrReferences: DocumentRenderContext | DocumentReferenceMap = { references: {} },
    depth = 0,
): string {
    const context = normalizeInlineRenderContext(contextOrReferences);
    if (depth > 8) {
        return escapeHtml(text);
    }

    const html: string[] = [];
    let index = 0;

    while (index < text.length) {
        const token = renderInlineTokenAt(text, index, context, depth);
        if (token) {
            html.push(token.html);
            index += token.length;
            continue;
        }

        const plainEnd = findNextInlineSpecialIndex(text, index + 1);
        html.push(escapeHtml(text.slice(index, plainEnd)));
        index = plainEnd;
    }

    return html.join("");
}

export function findFirstInlineToken(text: string): { start: number; token: MarkdownInlineToken } | null {
    for (let index = 0; index < text.length; index += 1) {
        const token =
            readInlineCodeToken(text, index) ??
            readHardBreakToken(text, index) ??
            readEscapedCharacter(text, index) ??
            readMathToken(text, index) ??
            readInlineToken(text, index, true) ??
            readInlineToken(text, index, false) ??
            readReferenceSyntaxToken(text, index, true) ??
            readReferenceSyntaxToken(text, index, false) ??
            readFootnoteReferenceSyntaxToken(text, index) ??
            readFormattingToken(text, index) ??
            readEmphasisToken(text, index) ??
            readAutolink(text, index) ??
            readBareUrlToken(text, index);
        if (token) {
            return { start: index, token };
        }
    }

    return null;
}

function renderInlineTokenAt(
    text: string,
    index: number,
    context: DocumentRenderContext,
    depth: number,
): { html: string; length: number } | null {
    const character = text[index];

    if (character === "`") {
        const inlineCode = readInlineCodeToken(text, index);
        return inlineCode ? { html: renderInlineCodeToken(inlineCode), length: inlineCode.raw.length } : null;
    }

    if (character === "\\") {
        const hardBreak = readHardBreakToken(text, index);
        if (hardBreak) {
            return { html: renderHardBreakToken(hardBreak), length: hardBreak.raw.length };
        }

        const escapedCharacter = readEscapedCharacter(text, index);
        return escapedCharacter
            ? { html: renderEscapedCharacter(escapedCharacter), length: escapedCharacter.raw.length }
            : null;
    }

    if (character === "$") {
        const math = readMathToken(text, index);
        return math ? { html: renderMathToken(math), length: math.raw.length } : null;
    }

    if (character === "<") {
        const autolink = readAutolink(text, index);
        return autolink ? { html: renderAutolinkToken(autolink), length: autolink.raw.length } : null;
    }

    if (character === "!" && text[index + 1] === "[") {
        const image = readInlineToken(text, index, true) ?? readReferenceToken(text, index, true, context.references);
        return image ? { html: renderImageToken(image), length: image.raw.length } : null;
    }

    if (character === "[" && text[index + 1] === "^") {
        const footnote = readFootnoteReferenceToken(text, index, context);
        return footnote ? { html: renderFootnoteReferenceToken(footnote), length: footnote.raw.length } : null;
    }

    if (character === "[") {
        const link = readInlineToken(text, index, false) ?? readReferenceToken(text, index, false, context.references);
        return link ? { html: renderLinkToken(link, context, depth + 1), length: link.raw.length } : null;
    }

    if (character === "~" || character === "=" || character === "^") {
        const formatting = readFormattingToken(text, index);
        return formatting
            ? { html: renderFormattingToken(formatting, context, depth + 1), length: formatting.raw.length }
            : null;
    }

    if (character === "*" || character === "_") {
        const emphasis = readEmphasisToken(text, index);
        return emphasis
            ? { html: renderEmphasisToken(emphasis, context, depth + 1), length: emphasis.raw.length }
            : null;
    }

    if (character === "\n") {
        const hardBreak = readHardBreakToken(text, index);
        return hardBreak ? { html: renderHardBreakToken(hardBreak), length: hardBreak.raw.length } : null;
    }

    if (isPotentialBareUrlStart(text, index)) {
        const url = readBareUrl(text, index);
        return url ? { html: renderBareUrl(url), length: url.length } : null;
    }

    return null;
}

function findNextInlineSpecialIndex(text: string, start: number): number {
    for (let index = start; index < text.length; index += 1) {
        if (isInlineSpecialCharacter(text, index)) {
            return index;
        }
    }

    return text.length;
}

function isInlineSpecialCharacter(text: string, index: number): boolean {
    const character = text[index];
    return (
        character === "`" ||
        character === "\\" ||
        character === "$" ||
        character === "<" ||
        character === "!" ||
        character === "[" ||
        character === "*" ||
        character === "_" ||
        character === "~" ||
        character === "=" ||
        character === "^" ||
        character === "\n" ||
        isPotentialBareUrlStart(text, index)
    );
}

function isPotentialBareUrlStart(text: string, index: number): boolean {
    const character = text[index].toLowerCase();
    if (character === "h") {
        return /^https?:\/\//i.test(text.slice(index, index + 8));
    }

    return character === "w" && /^www\./i.test(text.slice(index, index + 4));
}

function readMathToken(text: string, index: number): MathToken | null {
    if (text[index] !== "$" || isEscapedAt(text, index)) {
        return null;
    }

    const displayMode = text.startsWith("$$", index);
    if (!displayMode && (text[index - 1] === "$" || text[index + 1] === "$")) {
        return null;
    }

    const delimiter = displayMode ? "$$" : "$";
    const sourceStart = index + delimiter.length;
    if (sourceStart >= text.length) {
        return null;
    }

    if (!displayMode && /\s/.test(text[sourceStart])) {
        return null;
    }

    const sourceEnd = displayMode
        ? findDisplayMathClosingDelimiter(text, sourceStart)
        : findInlineMathClosingDelimiter(text, sourceStart);
    if (sourceEnd < 0) {
        return null;
    }

    const source = text.slice(sourceStart, sourceEnd);
    if ((!displayMode && source.trim() === "") || (!displayMode && /\s$/.test(source))) {
        return null;
    }

    return {
        raw: text.slice(index, sourceEnd + delimiter.length),
        source,
        displayMode,
    };
}

function findDisplayMathClosingDelimiter(text: string, startIndex: number): number {
    return findUnescapedSequence(text, "$$", startIndex);
}

function findInlineMathClosingDelimiter(text: string, startIndex: number): number {
    for (let index = startIndex; index < text.length; index += 1) {
        if (text[index] === "$" && !isEscapedAt(text, index) && text[index - 1] !== "$" && text[index + 1] !== "$") {
            return index;
        }
    }

    return -1;
}


type FootnoteRenderData = {
    numbers: Record<string, number>;
    referenceIds?: Record<string, string[]>;
    renderCursors?: Record<string, number>;
};

function normalizeInlineRenderContext(contextOrReferences: DocumentRenderContext | DocumentReferenceMap): DocumentRenderContext {
    if (isDocumentRenderContext(contextOrReferences)) {
        return contextOrReferences;
    }

    return { references: contextOrReferences };
}

function isDocumentRenderContext(value: DocumentRenderContext | DocumentReferenceMap): value is DocumentRenderContext {
    const references = (value as { references?: unknown }).references;
    return Boolean(references && typeof references === "object" && !("destination" in references));
}

function readFootnoteRenderData(context: DocumentRenderContext): FootnoteRenderData | null {
    const data = context.data;
    if (!data || typeof data !== "object" || !("footnotes" in data)) {
        return null;
    }

    const footnotes = (data as { footnotes?: unknown }).footnotes;
    if (!footnotes || typeof footnotes !== "object" || !("numbers" in footnotes)) {
        return null;
    }

    return footnotes as FootnoteRenderData;
}

export function normalizeExternalImageUrl(value: string): string | null {
    const trimmed = value.trim();

    if (/^data:image\/(?:gif|jpe?g|png|webp);/i.test(trimmed)) {
        return trimmed;
    }

    try {
        const url = new URL(trimmed);
        return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
    } catch {
        return null;
    }
}

function readInlineCodeToken(text: string, index: number): InlineCodeToken | null {
    if (text[index] !== "`" || isEscapedAt(text, index)) {
        return null;
    }

    const markerLength = countMarkerRun(text, index, "`");
    const marker = "`".repeat(markerLength);
    const end = text.indexOf(marker, index + markerLength);
    if (end < 0) {
        return null;
    }

    const raw = text.slice(index, end + markerLength);
    let code = text.slice(index + markerLength, end);
    if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim() !== "") {
        code = code.slice(1, -1);
    }

    return { raw, code };
}

function readEscapedCharacter(text: string, index: number): EscapedCharacterToken | null {
    const character = text[index + 1];

    if (text[index] !== "\\" || !character || !escapableCharacters.has(character)) {
        return null;
    }

    return {
        raw: text.slice(index, index + 2),
        character,
    };
}

function readHardBreakToken(text: string, index: number): HardBreakToken | null {
    if (text[index] === "\\" && text[index + 1] === "\n" && !isEscapedAt(text, index)) {
        return { raw: "\\\n" };
    }

    return text[index] === "\n" ? { raw: "\n" } : null;
}

function readInlineToken(text: string, index: number, image: boolean): InlineToken | null {
    const opener = image ? "![" : "[";
    if (!text.startsWith(opener, index)) {
        return null;
    }

    if (!image && text[index + 1] === "^") {
        return null;
    }

    const labelStart = index + opener.length;
    const labelEnd = findClosingBracket(text, labelStart);
    if (labelEnd < 0 || text[labelEnd + 1] !== "(") {
        return null;
    }

    const destinationStart = labelEnd + 2;
    const destinationEnd = findClosingParenthesis(text, destinationStart);
    if (destinationEnd < 0) {
        return null;
    }

    const destination = parseMarkdownDestinationWithTitle(text.slice(destinationStart, destinationEnd));
    if (!destination) {
        return null;
    }

    return {
        raw: text.slice(index, destinationEnd + 1),
        label: text.slice(labelStart, labelEnd),
        destination: destination.destination,
        title: destination.title,
    };
}

function readReferenceToken(
    text: string,
    index: number,
    image: boolean,
    references: DocumentReferenceMap,
): InlineToken | null {
    const token = readReferenceSyntaxToken(text, index, image);
    if (!token) {
        return null;
    }

    const normalizedLabel = normalizeReferenceLabel(token.referenceLabel || token.label);
    const reference = references[normalizedLabel];
    if (!reference) {
        return null;
    }

    return {
        raw: token.raw,
        label: token.label,
        destination: reference.destination,
        title: reference.title,
    };
}

function readReferenceSyntaxToken(
    text: string,
    index: number,
    image: boolean,
): (MarkdownInlineToken & { label: string; referenceLabel: string }) | null {
    const opener = image ? "![" : "[";
    if (!text.startsWith(opener, index)) {
        return null;
    }

    if (!image && text[index + 1] === "^") {
        return null;
    }

    const labelStart = index + opener.length;
    const labelEnd = findClosingBracket(text, labelStart);
    if (labelEnd < 0) {
        return null;
    }

    let referenceStart = labelEnd + 1;
    if (text[referenceStart] === " " && text[referenceStart + 1] === "[") {
        referenceStart += 1;
    }

    if (text[referenceStart] !== "[") {
        return {
            raw: text.slice(index, labelEnd + 1),
            label: text.slice(labelStart, labelEnd),
            referenceLabel: "",
        };
    }

    const referenceEnd = findClosingBracket(text, referenceStart + 1);
    if (referenceEnd < 0) {
        return null;
    }

    return {
        raw: text.slice(index, referenceEnd + 1),
        label: text.slice(labelStart, labelEnd),
        referenceLabel: text.slice(referenceStart + 1, referenceEnd),
    };
}


function readFormattingToken(text: string, index: number): FormattingToken | null {
    const marker = readFormattingMarker(text, index);
    if (!marker || isEscapedAt(text, index)) {
        return null;
    }

    const labelStart = index + marker.length;
    if (labelStart >= text.length || /\s/.test(text[labelStart])) {
        return null;
    }

    const labelEnd = findUnescapedSequence(text, marker, labelStart);
    if (labelEnd < 0) {
        return null;
    }

    const label = text.slice(labelStart, labelEnd);
    if (label === "" || /\s$/.test(label)) {
        return null;
    }

    return {
        raw: text.slice(index, labelEnd + marker.length),
        marker,
        label,
    };
}

function readFormattingMarker(text: string, index: number): FormattingToken["marker"] | null {
    if (text.startsWith("~~", index)) {
        return "~~";
    }

    if (text.startsWith("==", index)) {
        return "==";
    }

    if (text[index] === "~" && text[index + 1] !== "~" && text[index - 1] !== "~") {
        return "~";
    }

    if (text[index] === "^" && text[index + 1] !== "^" && text[index - 1] !== "^") {
        return "^";
    }

    return null;
}

function readFootnoteReferenceSyntaxToken(text: string, index: number): (MarkdownInlineToken & { label: string }) | null {
    if (!text.startsWith("[^", index) || isEscapedAt(text, index)) {
        return null;
    }

    const end = findClosingBracket(text, index + 2);
    if (end <= index + 2) {
        return null;
    }

    return {
        raw: text.slice(index, end + 1),
        label: text.slice(index + 2, end),
    };
}

function readFootnoteReferenceToken(
    text: string,
    index: number,
    context: DocumentRenderContext,
): FootnoteReferenceToken | null {
    const token = readFootnoteReferenceSyntaxToken(text, index);
    if (!token) {
        return null;
    }

    const footnotes = readFootnoteRenderData(context);
    const normalizedLabel = normalizeReferenceLabel(token.label);
    const number = footnotes?.numbers[normalizedLabel];
    return number && footnotes
        ? { raw: token.raw, label: token.label, number, id: readNextFootnoteReferenceId(footnotes, normalizedLabel) }
        : null;
}

function readNextFootnoteReferenceId(footnotes: FootnoteRenderData, normalizedLabel: string): string {
    const fallbackId = `fnref-${encodeURIComponent(normalizedLabel)}`;
    const ids = footnotes.referenceIds?.[normalizedLabel] ?? [fallbackId];
    footnotes.renderCursors = footnotes.renderCursors ?? {};

    const cursor = footnotes.renderCursors[normalizedLabel] ?? 0;
    footnotes.renderCursors[normalizedLabel] = cursor + 1;

    return ids[cursor] ?? `${fallbackId}-${cursor + 1}`;
}

function readEmphasisToken(text: string, index: number): EmphasisToken | null {
    const marker = readEmphasisMarker(text, index);
    if (!marker || isEscapedAt(text, index)) {
        return null;
    }

    const labelStart = index + marker.length;
    if (labelStart >= text.length || /\s/.test(text[labelStart])) {
        return null;
    }

    if (marker.includes("_") && index > 0 && /[A-Za-z0-9]/.test(text[index - 1])) {
        return null;
    }

    let labelEnd = findUnescapedSequence(text, marker, labelStart);
    while (labelEnd >= 0) {
        const label = text.slice(labelStart, labelEnd);
        const characterAfterMarker = text[labelEnd + marker.length] ?? "";

        if (
            label !== "" &&
            !/\s$/.test(label) &&
            !(marker.includes("_") && /[A-Za-z0-9]/.test(characterAfterMarker))
        ) {
            return {
                raw: text.slice(index, labelEnd + marker.length),
                marker,
                label,
                emphasis: marker.length === 1 || marker.length === 3,
                strong: marker.length >= 2,
            };
        }

        labelEnd = findUnescapedSequence(text, marker, labelEnd + marker.length);
    }

    return null;
}

function readEmphasisMarker(text: string, index: number): EmphasisToken["marker"] | null {
    if (text.startsWith("***", index)) {
        return "***";
    }

    if (text.startsWith("___", index)) {
        return "___";
    }

    if (text.startsWith("**", index)) {
        return "**";
    }

    if (text.startsWith("__", index)) {
        return "__";
    }

    if (text[index] === "*") {
        return "*";
    }

    if (text[index] === "_") {
        return "_";
    }

    return null;
}

function readAutolink(text: string, index: number): AutolinkToken | null {
    if (text[index] !== "<" || isEscapedAt(text, index)) {
        return null;
    }

    const end = text.indexOf(">", index + 1);
    if (end < 0) {
        return null;
    }

    const label = text.slice(index + 1, end);
    if (/^https?:\/\/[^\s<>]+$/i.test(label)) {
        return {
            raw: text.slice(index, end + 1),
            label,
            destination: label,
        };
    }

    if (/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(label)) {
        return {
            raw: text.slice(index, end + 1),
            label,
            destination: `mailto:${label}`,
        };
    }

    return null;
}

function renderInlineCodeToken(token: InlineCodeToken): string {
    const code = escapeHtml(token.code);

    return renderAtomicInlineToken(
        token.raw,
        "markdown-token markdown-code-token",
        "code",
        `<code data-source-ignore="true">${code}</code>`,
    );
}

function renderEscapedCharacter(token: EscapedCharacterToken): string {
    const character = escapeHtml(token.character);

    return renderAtomicInlineToken(
        token.raw,
        "markdown-token markdown-escape-token",
        "escape",
        `<span class="markdown-escape" data-source-ignore="true">${character}</span>`,
    );
}

function renderHardBreakToken(token: HardBreakToken): string {
    return renderAtomicInlineToken(
        token.raw,
        "markdown-token markdown-hard-break-token",
        "hard-break",
        `<span class="markdown-hard-break" data-source-ignore="true"><br></span>`,
    );
}

function renderMathToken(token: MathToken): string {
    const math = renderLatexMath(token.source, token.displayMode);
    const className = token.displayMode ? "markdown-token markdown-math-token markdown-display-math-token" : "markdown-token markdown-math-token";
    const kind = token.displayMode ? "display-math" : "math";

    return renderAtomicInlineToken(
        token.raw,
        className,
        kind,
        `<span class="markdown-math" data-source-ignore="true">${math}</span>`,
    );
}


function renderFormattingToken(token: FormattingToken, context: DocumentRenderContext, depth: number): string {
    const label = renderInlineMarkdown(token.label, context, depth);
    const tag = token.marker === "~~" ? "del" : token.marker === "==" ? "mark" : token.marker === "~" ? "sub" : "sup";
    const className =
        token.marker === "~~"
            ? "markdown-strikethrough"
            : token.marker === "=="
              ? "markdown-highlight"
              : token.marker === "~"
                ? "markdown-subscript"
                : "markdown-superscript";

    return renderAtomicInlineToken(
        token.raw,
        "markdown-token markdown-format-token",
        "formatting",
        `<${tag} class="${className}" data-source-ignore="true">${label}</${tag}>`,
    );
}

function renderFootnoteReferenceToken(token: FootnoteReferenceToken): string {
    const label = encodeURIComponent(normalizeReferenceLabel(token.label));
    return renderAtomicInlineToken(
        token.raw,
        "markdown-token markdown-footnote-reference-token",
        "footnote-reference",
        `<sup class="markdown-footnote-reference" data-source-ignore="true" id="${escapeHtml(token.id)}"><a class="markdown-link" href="#fn-${label}" data-href="#fn-${label}" tabindex="-1">${token.number}</a></sup>`,
    );
}

function renderEmphasisToken(token: EmphasisToken, context: DocumentRenderContext, depth: number): string {
    const label = renderInlineMarkdown(token.label, context, depth);

    if (token.strong && token.emphasis) {
        return renderAtomicInlineToken(
            token.raw,
            "markdown-token markdown-format-token",
            "strong-emphasis",
            `<strong class="markdown-strong" data-source-ignore="true"><em class="markdown-emphasis">${label}</em></strong>`,
        );
    }

    if (token.strong) {
        return renderAtomicInlineToken(
            token.raw,
            "markdown-token markdown-format-token",
            "strong",
            `<strong class="markdown-strong" data-source-ignore="true">${label}</strong>`,
        );
    }

    return renderAtomicInlineToken(
        token.raw,
        "markdown-token markdown-format-token",
        "emphasis",
        `<em class="markdown-emphasis" data-source-ignore="true">${label}</em>`,
    );
}

function renderImageToken(token: InlineToken): string {
    const source = escapeHtml(token.destination);
    const alt = escapeHtml(unescapeMarkdownText(token.label));
    const title = token.title ? ` data-image-title="${escapeHtml(token.title)}"` : "";
    const preserveKey = escapeHtml(createImagePreviewPreserveKey(token));

    return renderAtomicInlineToken(
        token.raw,
        "markdown-token markdown-image-token",
        "image",
        `<span class="markdown-image-preview" data-source-ignore="true" data-render-preserve-key="${preserveKey}" data-image-source="${source}" data-image-alt="${alt}"${title} data-state="loading" aria-hidden="true"></span>`,
    );
}

function createImagePreviewPreserveKey(token: InlineToken): string {
    return JSON.stringify(["markdown-image", token.destination, unescapeMarkdownText(token.label), token.title ?? ""]);
}

function renderLinkToken(token: InlineToken, context: DocumentRenderContext, depth: number): string {
    const href = normalizeLinkHref(token.destination);
    const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
    const labelHtml = renderInlineMarkdown(token.label, context, depth);
    const label = href
        ? `<a class="markdown-link" data-source-ignore="true" tabindex="-1" href="${escapeHtml(href)}" data-href="${escapeHtml(href)}"${title} rel="noreferrer">${labelHtml}</a>`
        : `<span class="markdown-link markdown-link-label" data-source-ignore="true"${title}>${labelHtml}</span>`;

    return renderAtomicInlineToken(token.raw, "markdown-token markdown-link-token", "link", label);
}

function renderAutolinkToken(token: AutolinkToken): string {
    return renderRawLink(token.label, token.destination, token.raw, "autolink");
}

function renderBareUrl(url: string): string {
    return renderRawLink(url, url, url, "url");
}

function renderRawLink(label: string, destination: string, raw: string, kind: "autolink" | "url"): string {
    const href = normalizeLinkHref(destination);
    if (!href) {
        return escapeHtml(raw);
    }

    const escapedHref = escapeHtml(href);
    return renderAtomicInlineToken(
        raw,
        "markdown-token markdown-link-token markdown-url-token",
        kind,
        `<a class="markdown-link" data-source-ignore="true" tabindex="-1" href="${escapedHref}" data-href="${escapedHref}" rel="noreferrer">${escapeHtml(label)}</a>`,
    );
}

function renderAtomicInlineToken(raw: string, className: string, kind: string, previewHtml: string): string {
    return `<span class="${className}" data-markdown-token-kind="${kind}" data-source-raw="${escapeHtmlAttribute(raw)}" contenteditable="false">${previewHtml}</span>`;
}

function escapeHtmlAttribute(value: string): string {
    return escapeHtml(value)
        .replace(/\t/g, "&#9;")
        .replace(/\n/g, "&#10;")
        .replace(/\r/g, "&#13;");
}

function readBareUrl(text: string, index: number): string | null {
    if (index > 0 && /[A-Za-z0-9]/.test(text[index - 1])) {
        return null;
    }

    const match = text.slice(index).match(/^(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/i);
    if (!match) {
        return null;
    }

    return trimTrailingUrlPunctuation(match[0]);
}

function readBareUrlToken(text: string, index: number): MarkdownInlineToken | null {
    const url = readBareUrl(text, index);
    return url ? { raw: url } : null;
}

function trimTrailingUrlPunctuation(value: string): string {
    let url = value;

    while (/[.,;:!?]$/.test(url)) {
        url = url.slice(0, -1);
    }

    while (url.endsWith(")") && countCharacters(url, "(") < countCharacters(url, ")")) {
        url = url.slice(0, -1);
    }

    return url;
}

function countCharacters(value: string, character: string): number {
    return value.split(character).length - 1;
}

function findClosingBracket(text: string, startIndex: number): number {
    let nestedDepth = 0;

    for (let index = startIndex; index < text.length; index += 1) {
        if (text[index] === "\\") {
            index += 1;
            continue;
        }

        if (text[index] === "[") {
            nestedDepth += 1;
            continue;
        }

        if (text[index] === "]") {
            if (nestedDepth === 0) {
                return index;
            }

            nestedDepth -= 1;
        }
    }

    return -1;
}

function findClosingParenthesis(text: string, startIndex: number): number {
    let nestedDepth = 0;

    for (let index = startIndex; index < text.length; index += 1) {
        if (text[index] === "\\") {
            index += 1;
            continue;
        }

        if (text[index] === "(") {
            nestedDepth += 1;
            continue;
        }

        if (text[index] === ")") {
            if (nestedDepth === 0) {
                return index;
            }

            nestedDepth -= 1;
        }
    }

    return -1;
}

function normalizeLinkHref(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed || /[\u0000-\u001F\u007F]/.test(trimmed) || /^javascript:/i.test(trimmed)) {
        return null;
    }

    const urlText = trimmed.match(/^www\./i) ? `https://${trimmed}` : trimmed;

    try {
        const url = new URL(urlText);
        return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" ? url.href : null;
    } catch {
        if (/\s/.test(trimmed) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) {
            return null;
        }

        return trimmed;
    }
}

function countMarkerRun(text: string, index: number, marker: string): number {
    let length = 0;

    while (text[index + length] === marker) {
        length += 1;
    }

    return length;
}
