import { escapeHtml } from "../../utils/text";
import { parseMarkdownFragment } from "./parse";
import { renderInlineMarkdown } from "./inline";
import { renderMarkdownBlock } from "./table";
import { renderExtendedMarkdownBlock, readMarkdownRenderContext } from "./render-context";
import type { ParsedBlock } from "../../editor/blocks/model";

export type ClipboardPayload = {
    markdown: string;
    plainText: string;
    html: string;
};

export type ClipboardInsert = {
    kind: "markdown" | "html" | "plain";
    markdown: string;
};

export function createMarkdownClipboardPayload(markdown: string): ClipboardPayload {
    return {
        markdown,
        plainText: markdown,
        html: renderClipboardHtml(markdown),
    };
}

export function writeMarkdownClipboardPayload(clipboard: DataTransfer, payload: ClipboardPayload): void {
    clipboard.setData("text/plain", payload.plainText);
    clipboard.setData("text/markdown", payload.markdown);
    clipboard.setData("text/html", payload.html);
}

export function readMarkdownClipboardInsert(clipboard: DataTransfer | null | undefined): ClipboardInsert | null {
    if (!clipboard) {
        return null;
    }

    const markdown = clipboard.getData("text/markdown");
    if (markdown) {
        return { kind: "markdown", markdown: normalizeLines(markdown) };
    }

    const html = clipboard.getData("text/html");
    if (html) {
        return { kind: "html", markdown: htmlToMarkdown(html) };
    }

    const plain = clipboard.getData("text/plain");
    return plain ? { kind: "plain", markdown: normalizeLines(plain) } : null;
}

export function htmlToMarkdown(html: string): string {
    const document = new DOMParser().parseFromString(html, "text/html");
    for (const element of Array.from(document.body.querySelectorAll("script, style, iframe, object, embed, link, meta"))) {
        element.remove();
    }

    const result = Array.from(document.body.childNodes).map((node) => convertBlockNode(node, 0)).join("");
    return normalizeLines(result)
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function renderClipboardHtml(markdown: string): string {
    const parsed = parseMarkdownFragment(markdown);
    const context = readMarkdownRenderContext(parsed.blocks);
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
    const inline = cleanRenderedInline(renderInlineMarkdown(item.block.text, context));
    const children = item.children.length > 0 ? renderClipboardListItems(item.children, context) : "";
    return `<li>${task}${inline}${children}</li>`;
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
            token.replaceWith(createImageElement(source, alt));
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
        if (element instanceof HTMLAnchorElement && !isSafeUrl(element.href)) {
            element.removeAttribute("href");
        }
        if (element instanceof HTMLImageElement && !isSafeUrl(element.src)) {
            element.removeAttribute("src");
        }
    }
    return template.innerHTML;
}

function createImageElement(source: string, alt: string): HTMLImageElement {
    const image = document.createElement("img");
    image.src = isSafeUrl(source) ? source : "";
    image.alt = alt;
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
    return `${convertInlineChildren(node)}${isBlockElement(tag) ? "\n" : ""}`;
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
    if (tag === "br") return "\n";
    if (tag === "strong" || tag === "b") return content ? `**${content}**` : "";
    if (tag === "em" || tag === "i") return content ? `*${content}*` : "";
    if (tag === "del" || tag === "s" || tag === "strike") return content ? `~~${content}~~` : "";
    if (tag === "code") return content ? `\`${content.replace(/`/g, "\\`")}\`` : "";
    if (tag === "a") {
        const href = node.getAttribute("href") ?? "";
        return href && isSafeUrl(href) ? `[${content}](${escapeMarkdownDestination(href)})` : content;
    }
    if (tag === "img") {
        const source = node.getAttribute("src") ?? "";
        const alt = escapeMarkdownText(node.getAttribute("alt") ?? "");
        return source && isSafeUrl(source) ? `![${alt}](${escapeMarkdownDestination(source)})` : alt;
    }
    return content;
}

function convertInlineChildren(element: Element): string {
    return Array.from(element.childNodes).map(convertInlineNode).join("").trim();
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
    return text.replace(/[\t\n\f\r ]+/g, " ");
}

function normalizeLines(text: string): string {
    return text.replace(/\r\n?/g, "\n");
}

function isSafeUrl(value: string): boolean {
    const normalized = value.trim().replace(/[\u0000-\u001f\u007f\s]+/g, "");
    return !/^(?:javascript|vbscript):/i.test(normalized) && (!/^data:/i.test(normalized) || /^data:image\/(?:gif|jpe?g|png|webp);/i.test(normalized));
}

function escapeMarkdownDestination(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/\)/g, "\\)");
}

function escapeMarkdownText(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}

function isBlockElement(tag: string): boolean {
    return new Set(["address", "aside", "details", "dialog", "dl", "fieldset", "figure", "footer", "form", "header", "main", "nav"]).has(tag);
}
