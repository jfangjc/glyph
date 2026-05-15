export type InlineToken = {
    raw: string;
    label: string;
    destination: string;
};

const htmlEscapes: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};

export function renderInlineMarkdown(text: string): string {
    let html = "";
    let index = 0;

    while (index < text.length) {
        const inlineCode = readInlineCode(text, index);
        if (inlineCode) {
            html += `<code>${escapeHtml(inlineCode)}</code>`;
            index += inlineCode.length;
            continue;
        }

        const image = readInlineToken(text, index, true);
        if (image) {
            html += renderImageToken(image);
            index += image.raw.length;
            continue;
        }

        const link = readInlineToken(text, index, false);
        if (link) {
            html += renderLinkToken(link);
            index += link.raw.length;
            continue;
        }

        const url = readBareUrl(text, index);
        if (url) {
            html += renderBareUrl(url);
            index += url.length;
            continue;
        }

        html += escapeHtml(text[index]);
        index += 1;
    }

    return html;
}

export function findFirstInlineToken(text: string): { start: number; token: InlineToken } | null {
    for (let index = 0; index < text.length; index += 1) {
        const token = readInlineToken(text, index, true) ?? readInlineToken(text, index, false);
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

function readInlineCode(text: string, index: number): string | null {
    if (text[index] !== "`") {
        return null;
    }

    const end = text.indexOf("`", index + 1);
    return end < 0 ? null : text.slice(index, end + 1);
}

function readInlineToken(text: string, index: number, image: boolean): InlineToken | null {
    const opener = image ? "![" : "[";
    if (!text.startsWith(opener, index)) {
        return null;
    }

    const labelStart = index + opener.length;
    const labelEnd = findUnescapedCharacter(text, "]", labelStart);
    if (labelEnd < 0 || text[labelEnd + 1] !== "(") {
        return null;
    }

    const destinationStart = labelEnd + 2;
    const destinationEnd = findClosingParenthesis(text, destinationStart);
    if (destinationEnd < 0) {
        return null;
    }

    const destination = readLinkDestination(text.slice(destinationStart, destinationEnd));
    if (!destination) {
        return null;
    }

    return {
        raw: text.slice(index, destinationEnd + 1),
        label: unescapeMarkdownDestination(text.slice(labelStart, labelEnd)),
        destination,
    };
}

function renderImageToken(token: InlineToken): string {
    const source = escapeHtml(token.destination);
    const alt = escapeHtml(token.label);
    const raw = escapeHtml(token.raw);

    return `<span class="markdown-token markdown-image-token"><span class="markdown-image-preview" contenteditable="false" data-markdown-ignore="true" data-image-source="${source}" data-image-alt="${alt}" data-state="loading" aria-hidden="true"></span><span class="markdown-token-source" spellcheck="false">${raw}</span></span>`;
}

function renderLinkToken(token: InlineToken): string {
    const href = normalizeExternalUrl(token.destination);
    const hrefAttributes = href ? ` href="${escapeHtml(href)}" data-href="${escapeHtml(href)}"` : "";
    const label = href
        ? `<a class="markdown-link" contenteditable="false" data-markdown-ignore="true" tabindex="-1"${hrefAttributes} rel="noreferrer">${escapeHtml(token.label)}</a>`
        : `<span class="markdown-link markdown-link-label" contenteditable="false" data-markdown-ignore="true">${escapeHtml(token.label)}</span>`;
    const raw = escapeHtml(token.raw);

    return `<span class="markdown-token markdown-link-token">${label}<span class="markdown-token-source" spellcheck="false">${raw}</span></span>&#8203;`;
}

function renderBareUrl(url: string): string {
    const href = normalizeExternalUrl(url);
    if (!href) {
        return escapeHtml(url);
    }

    const escapedHref = escapeHtml(href);
    return `<a class="markdown-link" contenteditable="false" href="${escapedHref}" data-href="${escapedHref}" data-markdown-raw="${escapeHtml(url)}" rel="noreferrer">${escapeHtml(url)}</a>`;
}

function readLinkDestination(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
        return "";
    }

    if (trimmed.startsWith("<")) {
        const closingBracket = findUnescapedCharacter(trimmed, ">", 1);
        return closingBracket > 1 ? unescapeMarkdownDestination(trimmed.slice(1, closingBracket)) : "";
    }

    const titleMatch = trimmed.match(/^(\S+)\s+(?:"[^"]*"|'[^']*'|\([^)]*\))$/);
    return unescapeMarkdownDestination(titleMatch?.[1] ?? trimmed);
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

function findUnescapedCharacter(text: string, character: string, startIndex: number): number {
    for (let index = startIndex; index < text.length; index += 1) {
        if (text[index] === "\\") {
            index += 1;
            continue;
        }

        if (text[index] === character) {
            return index;
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

function normalizeExternalUrl(value: string): string | null {
    const trimmed = value.trim();
    const urlText = trimmed.match(/^www\./i) ? `https://${trimmed}` : trimmed;

    try {
        const url = new URL(urlText);
        return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" ? url.href : null;
    } catch {
        return null;
    }
}

function unescapeMarkdownDestination(value: string): string {
    return value.replace(/\\([\\`*{}\[\]()#+\-.!_>])/g, "$1");
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (character) => htmlEscapes[character]);
}
