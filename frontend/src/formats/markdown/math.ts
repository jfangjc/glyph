import katex from "katex";
import type { ParsedBlock } from "../../editor/blocks/model";
import { escapeHtml } from "../../utils/text";
import { findUnescapedSequence } from "./utils";

const mathRenderCacheLimit = 512;
const mathRenderCache = new Map<string, string>();

export function renderLatexMath(source: string, displayMode: boolean): string {
    const cacheKey = `${displayMode ? "display" : "inline"}\u0000${source}`;
    const cached = mathRenderCache.get(cacheKey);
    if (cached !== undefined) {
        mathRenderCache.delete(cacheKey);
        mathRenderCache.set(cacheKey, cached);
        return cached;
    }

    let html: string;
    try {
        html = katex.renderToString(source, {
            displayMode,
            throwOnError: false,
            trust: false,
        });
    } catch {
        html = `<code>${escapeHtml(source)}</code>`;
    }

    mathRenderCache.set(cacheKey, html);
    if (mathRenderCache.size > mathRenderCacheLimit) {
        const oldestKey = mathRenderCache.keys().next().value;
        if (oldestKey !== undefined) {
            mathRenderCache.delete(oldestKey);
        }
    }

    return html;
}

export function readMathSourceText(rawMarkdown: string): string {
    const normalized = rawMarkdown.replace(/\r\n?/g, "\n");
    const singleLine = normalized.match(/^ {0,3}\$\$(.*?)\$\$\s*$/s);
    if (singleLine) {
        return singleLine[1];
    }

    const lines = normalized.split("\n");
    if (lines[0]?.match(/^ {0,3}\$\$\s*$/) && lines[lines.length - 1]?.match(/^ {0,3}\$\$\s*$/)) {
        return lines.slice(1, -1).join("\n");
    }

    return rawMarkdown;
}

export function splitCompactDisplayMathBlocks(text: string): ParsedBlock[] | null {
    const blocks: ParsedBlock[] = [];
    let cursor = 0;
    let foundMath = false;

    while (cursor < text.length) {
        const start = findUnescapedSequence(text, "$$", cursor);
        if (start < 0) {
            appendParagraphBlock(blocks, text.slice(cursor));
            break;
        }

        const sourceStart = start + 2;
        const end = findUnescapedSequence(text, "$$", sourceStart);
        if (end < 0) {
            appendParagraphBlock(blocks, text.slice(cursor));
            break;
        }

        const raw = text.slice(start, end + 2);
        const source = readMathSourceText(raw);
        if (source.trim() === "") {
            appendParagraphBlock(blocks, text.slice(cursor, end + 2));
            cursor = end + 2;
            continue;
        }

        appendParagraphBlock(blocks, text.slice(cursor, start));
        blocks.push({ type: "math", text: source, mathSource: raw });
        foundMath = true;
        cursor = end + 2;
    }

    return foundMath ? blocks : null;
}

function appendParagraphBlock(blocks: ParsedBlock[], text: string): void {
    if (text !== "") {
        blocks.push({ type: "paragraph", text });
    }
}
