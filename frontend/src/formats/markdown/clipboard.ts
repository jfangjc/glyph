import { maxRichClipboardHtmlLength } from "../../bridge/clipboard";
import { escapeHtml } from "../../utils/text";
import { parseMarkdownFragment } from "./parse";
import { renderInlineMarkdown } from "./inline";
import { renderMarkdownBlock } from "./table";
import { renderExtendedMarkdownBlock, readMarkdownRenderContext } from "./render-context";
import type { ParsedBlock } from "../../editor/blocks/model";
import type {
    ClipboardPayload,
    ClipboardReadResult,
    ClipboardSelectionContext,
} from "../types";

export function createMarkdownClipboardPayload(context: ClipboardSelectionContext): ClipboardPayload {
    const markdown = context.state.doc.slice(context.from, context.to);
    const html = renderClipboardHtml(context);
    return {
        markdown,
        plainText: readRenderedClipboardText(html, markdown),
        html,
    };
}

export function writeMarkdownClipboardPayload(clipboard: DataTransfer, payload: ClipboardPayload): void {
    clipboard.setData("text/plain", payload.plainText);
    clipboard.setData("text/markdown", payload.markdown);
    clipboard.setData("text/html", payload.html);
}

export function readMarkdownClipboardInsert(clipboard: DataTransfer | null | undefined): ClipboardReadResult | null {
    if (!clipboard) {
        return null;
    }

    if (clipboard.types.includes("text/markdown")) {
        const value = normalizeLines(clipboard.getData("text/markdown"));
        if (
            value !== "" ||
            (!clipboard.types.includes("text/html") && !clipboard.types.includes("text/plain"))
        ) {
            return { kind: "markdown", value };
        }
    }

    if (clipboard.types.includes("text/html")) {
        const html = clipboard.getData("text/html");
        if (html.length > maxRichClipboardHtmlLength) {
            return {
                kind: "plain",
                value: normalizeLines(new DOMParser().parseFromString(html, "text/html").body.textContent ?? ""),
                warning: "Rich clipboard content exceeded 5 MB and was pasted as plain text.",
            };
        }
        const value = htmlToMarkdown(html);
        if (value !== "" || !clipboard.types.includes("text/plain")) {
            return { kind: "html", value };
        }
    }

    return clipboard.types.includes("text/plain")
        ? { kind: "plain", value: normalizeLines(clipboard.getData("text/plain")) }
        : null;
}

export function htmlToMarkdown(html: string): string {
    const document = new DOMParser().parseFromString(html, "text/html");
    for (const element of Array.from(document.body.querySelectorAll("script, style, iframe, object, embed, link, meta"))) {
        element.remove();
    }

    const result = Array.from(document.body.childNodes).map((node) => convertBlockNode(node, 0)).join("");
    const normalized = normalizeLines(result)
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n");
    const withoutBoundaryLineBreaks = normalized.replace(/^\n+|\n+$/g, "");
    return withoutBoundaryLineBreaks || (normalized.includes("\n") ? "\n" : normalized);
}

function renderClipboardHtml(selection: ClipboardSelectionContext): string {
    const selectedBlocks = selection.blocks.map((block): ParsedBlock => {
        const from = Math.max(selection.from, block.contentFrom);
        const to = Math.min(selection.to, block.contentTo);
        return {
            ...block,
            text: from < to ? selection.state.doc.slice(from, to) : "",
        };
    }).filter((block) => block.text !== "" || block.type === "rule");
    const parsed = selectedBlocks.length > 0
        ? { blocks: selectedBlocks }
        : parseMarkdownFragment(selection.state.doc.slice(selection.from, selection.to));
    const context = readMarkdownRenderContext(selection.state.blocks.blocks);
    const html: string[] = [];
    for (let index = 0; index < parsed.blocks.length; index += 1) {
        const block = parsed.blocks[index];
        if (block.type === "list" || block.type === "ordered-list" || block.type === "todo") {
            const listBlocks: ParsedBlock[] = [];
            while (index < parsed.blocks.length && isListBlock(parsed.blocks[index])) {
                listBlocks.push(parsed.blocks[index]);
                index += 1;
            }
            index -= 1;
            html.push(renderClipboardList(listBlocks, context));
            continue;
        }

        const inline = cleanRenderedInline(renderInlineMarkdown(block.text, context));
        if (block.type.startsWith("heading-")) {
            const level = block.type.slice("heading-".length);
            html.push(`<h${level}>${inline}</h${level}>`);
        } else if (block.type === "quote") {
            html.push(`<blockquote>${inline}</blockquote>`);
        } else if (block.type === "code") {
            const language = block.codeInfo ? ` class="language-${escapeHtml(block.codeInfo)}"` : "";
            html.push(`<pre><code${language}>${escapeHtml(block.text)}</code></pre>`);
        } else if (block.type === "rule") {
            html.push("<hr>");
        } else if (block.type === "paragraph") {
            html.push(block.text === "" ? "<p><br></p>" : `<p>${inline}</p>`);
        } else {
            const rendered = renderMarkdownBlock(block.type, block.text, context, renderInlineMarkdown)
                ?? renderExtendedMarkdownBlock(block.type, block.text, context);
            html.push(rendered ?? `<p>${inline}</p>`);
        }
    }
    return html.join("");
}

function readRenderedClipboardText(html: string, markdown: string): string {
    const template = document.createElement("template");
    template.innerHTML = html;
    const text = readVisibleClipboardNodeText(template.content).replace(/\n$/, "");
    if (text) {
        return text;
    }
    return markdown
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/(\*\*|__|~~|==|\*|_|`+|~|\^)/g, "")
        .replace(/^ {0,3}(?:[-+*]|\d+[.)]|>)[ \t]+/gm, "")
        .replace(/\\([\\`*_[\]{}()#+\-.!|$~=^:])/g, "$1");
}

function readVisibleClipboardNodeText(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent ?? "";
    }
    if (node instanceof HTMLBRElement) {
        return "\n";
    }
    if (node instanceof HTMLImageElement) {
        return node.alt;
    }
    if (node instanceof HTMLInputElement) {
        return "";
    }

    if (node instanceof Element && node.classList.contains("katex")) {
        return node.querySelector("annotation[encoding='application/x-tex']")?.textContent ?? "";
    }

    if (node instanceof HTMLTableRowElement) {
        return `${Array.from(node.cells).map((cell) => (
            Array.from(cell.childNodes).map(readVisibleClipboardNodeText).join("")
        )).join("\t")}\n`;
    }

    if (node instanceof HTMLUListElement || node instanceof HTMLOListElement) {
        return readVisibleClipboardListText(node, 0);
    }

    if (node instanceof HTMLLIElement) {
        const nestedLists = Array.from(node.children).filter((child) => (
            child instanceof HTMLUListElement || child instanceof HTMLOListElement
        ));
        const nestedSet = new Set<Node>(nestedLists);
        let itemText = Array.from(node.childNodes)
            .filter((child) => !nestedSet.has(child))
            .map(readVisibleClipboardNodeText)
            .join("");
        if (node.firstElementChild instanceof HTMLInputElement && node.firstElementChild.type === "checkbox") {
            itemText = itemText.replace(/^ /, "");
        }
        return `${itemText}\n${nestedLists.map(readVisibleClipboardNodeText).join("")}`;
    }

    const text = Array.from(node.childNodes).map(readVisibleClipboardNodeText).join("");
    return node instanceof Element && /^(?:p|div|h[1-6]|blockquote|pre|li)$/.test(node.tagName.toLowerCase())
        ? `${text}\n`
        : text;
}

function readVisibleClipboardListText(list: HTMLUListElement | HTMLOListElement, depth: number): string {
    const items = Array.from(list.children).filter((child): child is HTMLLIElement => child instanceof HTMLLIElement);
    const orderedStart = list instanceof HTMLOListElement ? list.start : 1;

    return items.map((item, index) => {
        const nestedLists = Array.from(item.children).filter(
            (child): child is HTMLUListElement | HTMLOListElement => (
                child instanceof HTMLUListElement || child instanceof HTMLOListElement
            ),
        );
        const nestedSet = new Set<Node>(nestedLists);
        const checkbox = Array.from(item.children).find(
            (child): child is HTMLInputElement => child instanceof HTMLInputElement && child.type === "checkbox",
        );
        const itemText = Array.from(item.childNodes)
            .filter((child) => !nestedSet.has(child) && child !== checkbox)
            .map(readVisibleClipboardNodeText)
            .join("")
            .replace(/^ /, "");
        const orderedNumber = item.hasAttribute("value") ? item.value : orderedStart + index;
        const marker = checkbox
            ? `- [${checkbox.checked ? "x" : " "}] `
            : list instanceof HTMLOListElement ? `${orderedNumber}. ` : "- ";
        const line = `${"  ".repeat(depth)}${marker}${itemText}\n`;
        return line + nestedLists.map((nested) => readVisibleClipboardListText(nested, depth + 1)).join("");
    }).join("");
}

type ClipboardListItem = {
    block: ParsedBlock;
    children: ClipboardListItem[];
};

function isListBlock(block: ParsedBlock): boolean {
    return block.type === "list" || block.type === "ordered-list" || block.type === "todo";
}

function renderClipboardList(blocks: ParsedBlock[], context: ReturnType<typeof readMarkdownRenderContext>): string {
    const roots: ClipboardListItem[] = [];
    const lastAtDepth: ClipboardListItem[] = [];

    for (const block of blocks) {
        const requestedDepth = Math.max(0, block.indent ?? 0);
        const depth = Math.min(requestedDepth, lastAtDepth.length);
        const item: ClipboardListItem = { block, children: [] };
        if (depth === 0) {
            roots.push(item);
        } else {
            lastAtDepth[depth - 1].children.push(item);
        }
        lastAtDepth[depth] = item;
        lastAtDepth.length = depth + 1;
    }

    return renderClipboardListItems(roots, context);
}

function renderClipboardListItems(
    items: ClipboardListItem[],
    context: ReturnType<typeof readMarkdownRenderContext>,
): string {
    let html = "";
    for (let index = 0; index < items.length;) {
        const listType = items[index].block.type === "ordered-list" ? "ol" : "ul";
        const group: ClipboardListItem[] = [];
        while (index < items.length && (items[index].block.type === "ordered-list" ? "ol" : "ul") === listType) {
            group.push(items[index]);
            index += 1;
        }
        const start = listType === "ol" && group[0].block.listNumber && group[0].block.listNumber !== "1"
            ? ` start="${Number(group[0].block.listNumber)}"`
            : "";
        html += `<${listType}${start}>${group.map((item) => renderClipboardListItem(item, context)).join("")}</${listType}>`;
    }
    return html;
}

function renderClipboardListItem(
    item: ClipboardListItem,
    context: ReturnType<typeof readMarkdownRenderContext>,
): string {
    const task = item.block.type === "todo"
        ? `<input type="checkbox" disabled${item.block.checked ? " checked" : ""}> `
        : "";
    const value = item.block.type === "ordered-list" && item.block.listNumber
        ? ` value="${Number(item.block.listNumber)}"`
        : "";
    const inline = cleanRenderedInline(renderInlineMarkdown(item.block.text, context));
    const children = item.children.length > 0 ? renderClipboardListItems(item.children, context) : "";
    return `<li${value}>${task}${inline}${children}</li>`;
}

function cleanRenderedInline(html: string): string {
    const template = document.createElement("template");
    template.innerHTML = html;
    for (const token of Array.from(template.content.querySelectorAll<HTMLElement>(".markdown-token"))) {
        const preview = token.querySelector<HTMLElement>("[data-source-ignore='true']");
        if (token.classList.contains("markdown-image-token")) {
            const image = token.querySelector<HTMLElement>(".markdown-image-preview");
            const source = image?.dataset.imageSource ?? "";
            const alt = image?.dataset.imageAlt ?? "";
            const title = image?.dataset.imageTitle ?? "";
            token.replaceWith(createImageElement(source, alt, title));
        } else if (preview) {
            token.replaceWith(preview);
        } else {
            token.replaceWith(document.createTextNode(token.textContent ?? ""));
        }
    }
    for (const element of Array.from(template.content.querySelectorAll<HTMLElement>("*"))) {
        for (const attribute of Array.from(element.attributes)) {
            if (
                attribute.name.startsWith("data-") ||
                attribute.name.startsWith("on") ||
                attribute.name === "contenteditable" ||
                attribute.name === "tabindex" ||
                attribute.name === "style"
            ) {
                element.removeAttribute(attribute.name);
            }
        }
        if (element instanceof HTMLAnchorElement && !isSafeLinkUrl(element.getAttribute("href") ?? "")) {
            element.removeAttribute("href");
        }
        if (element instanceof HTMLImageElement && !isSafeImageUrl(element.getAttribute("src") ?? "")) {
            element.removeAttribute("src");
        }
    }
    return template.innerHTML;
}

function createImageElement(source: string, alt: string, title: string): HTMLImageElement {
    const image = document.createElement("img");
    if (isSafeImageUrl(source)) {
        image.setAttribute("src", source);
    }
    image.alt = alt;
    if (title) image.title = title;
    return image;
}

function convertBlockNode(node: Node, depth: number): string {
    if (node.nodeType === Node.TEXT_NODE) {
        return normalizeInlineText(node.textContent ?? "");
    }
    if (!(node instanceof Element)) {
        return "";
    }

    const tag = node.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
        return `${"#".repeat(Number(tag[1]))} ${convertInlineChildren(node)}\n\n`;
    }
    if (tag === "p" || tag === "div" || tag === "section" || tag === "article") {
        return `${convertInlineChildren(node)}\n\n`;
    }
    if (tag === "blockquote") {
        return `${convertInlineChildren(node).split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
    }
    if (tag === "pre") {
        const code = node.textContent ?? "";
        const language = node.querySelector("code")?.className.match(/language-([^\s]+)/)?.[1] ?? "";
        const fence = code.includes("```") ? "````" : "```";
        return `${fence}${language}\n${code.replace(/\n$/, "")}\n${fence}\n\n`;
    }
    if (tag === "ul" || tag === "ol") {
        return `${convertList(node, depth)}\n`;
    }
    if (tag === "table") {
        return `${convertTable(node)}\n\n`;
    }
    if (tag === "hr") {
        return "---\n\n";
    }
    return isBlockElement(tag)
        ? `${convertInlineChildren(node)}\n`
        : convertInlineNode(node);
}

function convertInlineNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
        return normalizeInlineText(node.textContent ?? "");
    }
    if (!(node instanceof Element)) {
        return "";
    }
    const tag = node.tagName.toLowerCase();
    const content = convertInlineChildren(node);
    if (tag === "br") return "  \n";
    if (tag === "strong" || tag === "b") return content ? `**${content}**` : "";
    if (tag === "em" || tag === "i") return content ? `*${content}*` : "";
    if (tag === "del" || tag === "s" || tag === "strike") return content ? `~~${content}~~` : "";
    if (tag === "mark") return content ? `==${content}==` : "";
    if (tag === "sub") return content ? `~${content}~` : "";
    if (tag === "sup") return content ? `^${content}^` : "";
    if (tag === "code") return serializeInlineCode(node.textContent ?? "");
    if (tag === "a") {
        const href = node.getAttribute("href") ?? "";
        const title = node.getAttribute("title") ?? "";
        return href && isSafeLinkUrl(href) ? `[${content}](${serializeMarkdownDestination(href, title)})` : content;
    }
    if (tag === "img") {
        const source = node.getAttribute("src") ?? "";
        const alt = escapeMarkdownText(node.getAttribute("alt") ?? "");
        const title = node.getAttribute("title") ?? "";
        return source && isSafeImageUrl(source)
            ? `![${alt}](${serializeMarkdownDestination(source, title)})`
            : alt;
    }
    return content;
}

function convertInlineChildren(element: Element): string {
    return Array.from(element.childNodes).map(convertInlineNode).join("");
}

function convertList(list: Element, depth: number): string {
    const ordered = list.tagName.toLowerCase() === "ol";
    let number = Number(list.getAttribute("start") ?? "1");
    return Array.from(list.children).filter((child) => child.tagName.toLowerCase() === "li").map((item) => {
        const nested = Array.from(item.children).filter((child) => /^(ul|ol)$/i.test(child.tagName));
        const body = Array.from(item.childNodes).filter((child) => !(child instanceof Element && /^(ul|ol)$/i.test(child.tagName)))
            .map(convertInlineNode).join("").trim();
        const checkbox = item.querySelector(":scope > input[type='checkbox']") as HTMLInputElement | null;
        const marker = ordered ? `${number++}.` : "-";
        const task = checkbox ? `[${checkbox.checked ? "x" : " "}] ` : "";
        const line = `${"  ".repeat(depth)}${marker} ${task}${body}\n`;
        return line + nested.map((child) => convertList(child, depth + 1)).join("");
    }).join("");
}

function convertTable(table: Element): string {
    const rows = Array.from(table.querySelectorAll("tr")).map((row) => (
        Array.from(row.querySelectorAll(":scope > th, :scope > td")).map((cell) => convertInlineChildren(cell).replace(/\|/g, "\\|"))
    ));
    if (rows.length === 0) return "";
    const width = Math.max(...rows.map((row) => row.length));
    const serialize = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => row[index] ?? "").join(" | ")} |`;
    return [serialize(rows[0]), serialize(Array.from({ length: width }, () => "---")), ...rows.slice(1).map(serialize)].join("\n");
}

function normalizeInlineText(text: string): string {
    return text
        .replace(/[\t\n\f\r ]+/g, " ")
        .replace(/\\/g, "\\\\")
        .replace(/([`*_[\]<>])/g, "\\$1");
}

function normalizeLines(text: string): string {
    return text.replace(/\r\n?/g, "\n");
}

function isSafeLinkUrl(value: string): boolean {
    const normalized = value.trim().replace(/[\u0000-\u001f\u007f\s]+/g, "");
    return /^(?:https?:|mailto:|#)/i.test(normalized);
}

function isSafeImageUrl(value: string): boolean {
    const normalized = value.trim().replace(/[\u0000-\u001f\u007f\s]+/g, "");
    return /^(?:https?:|glyph-pending-image:)/i.test(normalized) ||
        /^data:image\/(?:gif|jpe?g|png|webp);base64,/i.test(normalized);
}

function escapeMarkdownDestination(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/\)/g, "\\)");
}

function serializeMarkdownDestination(destination: string, title: string): string {
    const escapedDestination = escapeMarkdownDestination(destination);
    if (!title) return escapedDestination;
    const normalizedTitle = title.replace(/[\r\n]+/g, " ");
    const escapedBackslashes = normalizedTitle.replace(/\\/g, "\\\\");
    if (!normalizedTitle.includes('"')) {
        return `${escapedDestination} "${escapedBackslashes}"`;
    }
    if (!normalizedTitle.includes("'")) {
        return `${escapedDestination} '${escapedBackslashes}'`;
    }
    return `${escapedDestination} (${escapedBackslashes.replace(/\)/g, "\\)")})`;
}

function escapeMarkdownText(value: string): string {
    return value
        .replace(/[\t\n\f\r ]+/g, " ")
        .replace(/([\\[\]])/g, "\\$1");
}

function serializeInlineCode(value: string): string {
    if (value === "") {
        return "";
    }
    const longestRun = Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
    const fence = "`".repeat(longestRun + 1);
    const needsPadding = value.startsWith("`") || value.endsWith("`") || value.startsWith(" ") || value.endsWith(" ");
    return needsPadding ? `${fence} ${value} ${fence}` : `${fence}${value}${fence}`;
}

function isBlockElement(tag: string): boolean {
    return new Set(["address", "aside", "details", "dialog", "dl", "fieldset", "figure", "footer", "form", "header", "main", "nav"]).has(tag);
}
