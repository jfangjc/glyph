import {
    normalizeReferenceLabel,
    parseMarkdownDestinationWithTitle,
    unescapeMarkdownText,
    type MarkdownReferenceMap,
} from "./references";

export type InlineToken = {
    raw: string;
    label: string;
    destination: string;
    title?: string;
};

type InlineCodeToken = {
    raw: string;
    code: string;
};

type EscapedCharacterToken = {
    raw: string;
    character: string;
};

type EmphasisToken = {
    raw: string;
    marker: "*" | "**" | "***" | "_" | "__" | "___";
    label: string;
    emphasis: boolean;
    strong: boolean;
};

type AutolinkToken = {
    raw: string;
    label: string;
    destination: string;
};

type MarkdownInlineToken = {
    raw: string;
};

const htmlEscapes: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};

const escapableCharacters = new Set(["\\", "`", "*", "_", "{", "}", "[", "]", "<", ">", "(", ")", "#", "+", "-", ".", "!", "|"]);

export function renderInlineMarkdown(text: string, references: MarkdownReferenceMap = {}, depth = 0): string {
    if (depth > 8) {
        return escapeHtml(text);
    }

    let html = "";
    let index = 0;

    while (index < text.length) {
        const inlineCode = readInlineCodeToken(text, index);
        if (inlineCode) {
            html += renderInlineCodeToken(inlineCode);
            index += inlineCode.raw.length;
            continue;
        }

        const escapedCharacter = readEscapedCharacter(text, index);
        if (escapedCharacter) {
            html += renderEscapedCharacter(escapedCharacter);
            index += escapedCharacter.raw.length;
            continue;
        }

        const autolink = readAutolink(text, index);
        if (autolink) {
            html += renderAutolinkToken(autolink);
            index += autolink.raw.length;
            continue;
        }

        const image = readInlineToken(text, index, true) ?? readReferenceToken(text, index, true, references);
        if (image) {
            html += renderImageToken(image);
            index += image.raw.length;
            continue;
        }

        const link = readInlineToken(text, index, false) ?? readReferenceToken(text, index, false, references);
        if (link) {
            html += renderLinkToken(link, references, depth + 1);
            index += link.raw.length;
            continue;
        }

        const emphasis = readEmphasisToken(text, index);
        if (emphasis) {
            html += renderEmphasisToken(emphasis, references, depth + 1);
            index += emphasis.raw.length;
            continue;
        }

        const url = readBareUrl(text, index);
        if (url) {
            html += renderBareUrl(url);
            index += url.length;
            continue;
        }

        if (text[index] === "\\" && text[index + 1] === "\n") {
            html += '<br data-markdown-raw="\\&#10;">';
            index += 2;
            continue;
        }

        if (text[index] === "\n") {
            html += '<br data-markdown-raw="&#10;">';
            index += 1;
            continue;
        }

        html += escapeHtml(text[index]);
        index += 1;
    }

    return html;
}

export function findFirstInlineToken(text: string): { start: number; token: MarkdownInlineToken } | null {
    for (let index = 0; index < text.length; index += 1) {
        const token =
            readInlineCodeToken(text, index) ??
            readInlineToken(text, index, true) ??
            readInlineToken(text, index, false) ??
            readReferenceSyntaxToken(text, index, true) ??
            readReferenceSyntaxToken(text, index, false) ??
            readEmphasisToken(text, index) ??
            readAutolink(text, index) ??
            readBareUrlToken(text, index);
        if (token) {
            return { start: index, token };
        }
    }

    return null;
}

export function normalizeExternalImageUrl(value: string): string | null {
    const trimmed = value.trim();

    if (/^data:image\//i.test(trimmed)) {
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

function readInlineToken(text: string, index: number, image: boolean): InlineToken | null {
    const opener = image ? "![" : "[";
    if (!text.startsWith(opener, index)) {
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
    references: MarkdownReferenceMap,
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
        return null;
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
    const raw = escapeHtml(token.raw);
    const code = escapeHtml(token.code);

    return `<span class="markdown-token markdown-code-token"><code contenteditable="false" data-markdown-ignore="true">${code}</code><span class="markdown-token-source" spellcheck="false">${raw}</span></span>&#8203;`;
}

function renderEscapedCharacter(token: EscapedCharacterToken): string {
    return `<span class="markdown-escape" data-markdown-raw="${escapeHtml(token.raw)}">${escapeHtml(token.character)}</span>`;
}

function renderEmphasisToken(token: EmphasisToken, references: MarkdownReferenceMap, depth: number): string {
    const raw = escapeHtml(token.raw);
    const label = renderInlineMarkdown(token.label, references, depth);

    if (token.strong && token.emphasis) {
        return `<span class="markdown-token markdown-format-token"><strong class="markdown-strong" contenteditable="false" data-markdown-ignore="true"><em class="markdown-emphasis">${label}</em></strong><span class="markdown-token-source" spellcheck="false">${raw}</span></span>&#8203;`;
    }

    if (token.strong) {
        return `<span class="markdown-token markdown-format-token"><strong class="markdown-strong" contenteditable="false" data-markdown-ignore="true">${label}</strong><span class="markdown-token-source" spellcheck="false">${raw}</span></span>&#8203;`;
    }

    return `<span class="markdown-token markdown-format-token"><em class="markdown-emphasis" contenteditable="false" data-markdown-ignore="true">${label}</em><span class="markdown-token-source" spellcheck="false">${raw}</span></span>&#8203;`;
}

function renderImageToken(token: InlineToken): string {
    const source = escapeHtml(token.destination);
    const alt = escapeHtml(unescapeMarkdownText(token.label));
    const raw = escapeHtml(token.raw);
    const title = token.title ? ` data-image-title="${escapeHtml(token.title)}"` : "";

    return `<span class="markdown-token markdown-image-token"><span class="markdown-image-preview" contenteditable="false" data-markdown-ignore="true" data-image-source="${source}" data-image-alt="${alt}"${title} data-state="loading" aria-hidden="true"></span><span class="markdown-token-source" spellcheck="false">${raw}</span></span>`;
}

function renderLinkToken(token: InlineToken, references: MarkdownReferenceMap, depth: number): string {
    const href = normalizeLinkHref(token.destination);
    const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
    const labelHtml = renderInlineMarkdown(token.label, references, depth);
    const label = href
        ? `<a class="markdown-link" contenteditable="false" data-markdown-ignore="true" tabindex="-1" href="${escapeHtml(href)}" data-href="${escapeHtml(href)}"${title} rel="noreferrer">${labelHtml}</a>`
        : `<span class="markdown-link markdown-link-label" contenteditable="false" data-markdown-ignore="true"${title}>${labelHtml}</span>`;
    const raw = escapeHtml(token.raw);

    return `<span class="markdown-token markdown-link-token">${label}<span class="markdown-token-source" spellcheck="false">${raw}</span></span>&#8203;`;
}

function renderAutolinkToken(token: AutolinkToken): string {
    return renderRawLink(token.label, token.destination, token.raw);
}

function renderBareUrl(url: string): string {
    return renderRawLink(url, url, url);
}

function renderRawLink(label: string, destination: string, raw: string): string {
    const href = normalizeLinkHref(destination);
    if (!href) {
        return escapeHtml(raw);
    }

    const escapedHref = escapeHtml(href);
    return `<span class="markdown-token markdown-link-token markdown-url-token"><a class="markdown-link" contenteditable="false" data-markdown-ignore="true" tabindex="-1" href="${escapedHref}" data-href="${escapedHref}" rel="noreferrer">${escapeHtml(label)}</a><span class="markdown-token-source" spellcheck="false">${escapeHtml(raw)}</span></span>&#8203;`;
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

function findUnescapedSequence(text: string, sequence: string, startIndex: number): number {
    for (let index = startIndex; index < text.length; index += 1) {
        if (text[index] === "\\") {
            index += 1;
            continue;
        }

        if (text.startsWith(sequence, index)) {
            return index;
        }
    }

    return -1;
}

function isEscapedAt(text: string, index: number): boolean {
    let slashCount = 0;

    for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
        slashCount += 1;
    }

    return slashCount % 2 === 1;
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

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (character) => htmlEscapes[character]);
}
