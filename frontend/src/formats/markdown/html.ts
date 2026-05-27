import type { ParsedBlock } from "../../editor/blocks/model";

export type MarkdownHtmlBlock = {
    block: ParsedBlock;
    consumedLines: number;
};

type HtmlBlockStart =
    | { end: "blank" }
    | { end: "pattern"; closingPattern: RegExp };

const blockHtmlTagNames = [
    "address",
    "article",
    "aside",
    "base",
    "basefont",
    "blockquote",
    "body",
    "caption",
    "center",
    "col",
    "colgroup",
    "dd",
    "details",
    "dialog",
    "dir",
    "div",
    "dl",
    "dt",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "frame",
    "frameset",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "head",
    "header",
    "hr",
    "html",
    "iframe",
    "legend",
    "li",
    "link",
    "main",
    "menu",
    "menuitem",
    "nav",
    "noframes",
    "ol",
    "optgroup",
    "option",
    "p",
    "param",
    "search",
    "section",
    "summary",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "title",
    "tr",
    "track",
    "ul",
];

const blockHtmlTagPattern = blockHtmlTagNames.join("|");
const blockHtmlTagLinePattern = new RegExp(`^ {0,3}</?(?:${blockHtmlTagPattern})(?=[\\s>/])[^>]*>`, "i");
const completeHtmlTagLinePattern = /^ {0,3}<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s+[A-Za-z_:][A-Za-z0-9:._-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>\s*$/;
const pairedHtmlElementLinePattern = /^ {0,3}<([A-Za-z][A-Za-z0-9:-]*)(?:\s+[^<>]*)?>[\s\S]*<\/\1>\s*$/i;
const removedHtmlElementNames = new Set(["script", "iframe", "object", "embed", "base", "link", "meta"]);
const urlHtmlAttributeNames = new Set([
    "action",
    "data",
    "formaction",
    "href",
    "poster",
    "src",
    "xlink:href",
]);

export function readMarkdownHtmlBlock(lines: string[], index: number): MarkdownHtmlBlock | null {
    const start = readMarkdownHtmlBlockStart(lines[index]);
    if (!start) {
        return null;
    }

    const htmlLines: string[] = [];
    let cursor = index;

    if (start.end === "pattern") {
        while (cursor < lines.length) {
            htmlLines.push(lines[cursor]);
            if (start.closingPattern.test(lines[cursor])) {
                break;
            }
            cursor += 1;
        }

        return {
            block: { type: "html", text: htmlLines.join("\n") },
            consumedLines: htmlLines.length,
        };
    }

    while (cursor < lines.length && lines[cursor].trim() !== "") {
        htmlLines.push(lines[cursor]);
        cursor += 1;
    }

    return {
        block: { type: "html", text: htmlLines.join("\n") },
        consumedLines: htmlLines.length,
    };
}

export function isMarkdownHtmlBlockStart(line: string | undefined): boolean {
    return Boolean(readMarkdownHtmlBlockStart(line));
}

export function readSingleLineMarkdownHtmlBlock(line: string): ParsedBlock | null {
    if (line.includes("\n")) {
        return null;
    }

    const start = readMarkdownHtmlBlockStart(line);
    if (!start) {
        return null;
    }

    if (start.end === "pattern" && !start.closingPattern.test(line)) {
        return null;
    }

    return { type: "html", text: line };
}

export function renderMarkdownHtmlBlock(source: string): string {
    const template = document.createElement("template");
    template.innerHTML = source;
    sanitizeMarkdownHtml(template.content);
    return template.innerHTML;
}

function readMarkdownHtmlBlockStart(line: string | undefined): HtmlBlockStart | null {
    if (!line || !line.match(/^ {0,3}</)) {
        return null;
    }

    const rawHtmlElement = line.match(/^ {0,3}<\/?(script|pre|style|textarea)(?=[\s>/])[^>]*>/i);
    if (rawHtmlElement) {
        return {
            end: "pattern",
            closingPattern: new RegExp(`</${rawHtmlElement[1]}\\s*>`, "i"),
        };
    }

    if (line.match(/^ {0,3}<!--/)) {
        return { end: "pattern", closingPattern: /-->/ };
    }

    if (line.match(/^ {0,3}<\?/)) {
        return { end: "pattern", closingPattern: /\?>/ };
    }

    if (line.match(/^ {0,3}<!\[CDATA\[/)) {
        return { end: "pattern", closingPattern: /\]\]>/ };
    }

    if (line.match(/^ {0,3}<![A-Z]/)) {
        return { end: "pattern", closingPattern: />/ };
    }

    if (
        blockHtmlTagLinePattern.test(line) ||
        completeHtmlTagLinePattern.test(line) ||
        pairedHtmlElementLinePattern.test(line)
    ) {
        return { end: "blank" };
    }

    return null;
}

function sanitizeMarkdownHtml(root: ParentNode): void {
    for (const element of Array.from(root.querySelectorAll("*"))) {
        const tagName = element.tagName.toLowerCase();
        if (removedHtmlElementNames.has(tagName)) {
            element.remove();
            continue;
        }

        for (const attribute of Array.from(element.attributes)) {
            const name = attribute.name.toLowerCase();
            if (name.startsWith("on") || name === "srcdoc" || isUnsafeHtmlUrlAttribute(name, attribute.value)) {
                element.removeAttribute(attribute.name);
            }
        }
    }
}

function isUnsafeHtmlUrlAttribute(name: string, value: string): boolean {
    if (!urlHtmlAttributeNames.has(name)) {
        return false;
    }

    const normalized = value.trim().replace(/[\u0000-\u001F\u007F\s]+/g, "");
    if (/^(?:javascript|vbscript):/i.test(normalized)) {
        return true;
    }

    return /^data:/i.test(normalized) && !/^data:image\/(?:gif|jpe?g|png|webp);/i.test(normalized);
}
