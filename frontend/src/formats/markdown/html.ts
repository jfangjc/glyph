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
const removedHtmlElementNames = new Set([
    "script", "style", "iframe", "object", "embed", "base", "link", "meta",
    "form", "input", "button", "select", "textarea", "video", "audio", "canvas",
]);
const allowedHtmlElementNames = new Set([
    "p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "code",
    "em", "strong", "del", "s", "ul", "ol", "li", "a", "img", "hr", "table",
    "thead", "tbody", "tfoot", "tr", "th", "td", "sup", "sub", "div", "span",
]);
const allowedAttributesByTag: Record<string, Set<string>> = {
    a: new Set(["href", "title"]),
    img: new Set(["src", "alt", "title", "width", "height"]),
    ol: new Set(["start"]),
    td: new Set(["colspan", "rowspan", "align"]),
    th: new Set(["colspan", "rowspan", "align"]),
};

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
        if (!allowedHtmlElementNames.has(tagName)) {
            element.replaceWith(...Array.from(element.childNodes));
            continue;
        }

        for (const attribute of Array.from(element.attributes)) {
            const name = attribute.name.toLowerCase();
            const allowed = allowedAttributesByTag[tagName]?.has(name) ?? false;
            if (!allowed || isUnsafeHtmlUrlAttribute(tagName, name, attribute.value)) {
                element.removeAttribute(attribute.name);
            }
        }

        if (element instanceof HTMLAnchorElement) {
            element.rel = "noreferrer";
        }
    }
}

function isUnsafeHtmlUrlAttribute(tagName: string, name: string, value: string): boolean {
    if (name !== "href" && name !== "src") {
        return false;
    }

    const normalized = value.trim().replace(/[\u0000-\u001F\u007F\s]+/g, "");
    if (tagName === "a" && name === "href") {
        return !/^(?:https?:|mailto:|#)/i.test(normalized);
    }

    if (tagName === "img" && name === "src") {
        return !/^(?:https?:)/i.test(normalized) &&
            !/^data:image\/(?:gif|jpe?g|png|webp);base64,/i.test(normalized);
    }
    return true;
}
