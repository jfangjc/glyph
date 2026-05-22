import { caretSpacerCharacter } from "../selection/rendered-content-dom";
import { escapeHtml } from "../../utils/text";

export type BlockSource = {
    prefix?: string;
    suffix?: string;
    atomic?: string;
};

export type BlockSourcePosition = "prefix" | "suffix" | "atomic";

export function renderPlainTextBlockContent(content: HTMLElement, text: string, source: BlockSource): void {
    content.replaceChildren();
    appendBlockSourceElement(content, source.prefix, "prefix");
    content.append(document.createTextNode(renderPlainTextContentText(text)));
    appendBlockSourceElement(content, source.suffix, "suffix");
}

export function renderCodeBlockContent(content: HTMLElement, text: string, source: BlockSource): void {
    content.replaceChildren();
    appendBlockSourceElement(content, source.prefix, "prefix");
    appendCodeBlockBodyElement(content, text);
    appendBlockSourceElement(content, source.suffix, "suffix");
}

export function renderAtomicBlockContent(content: HTMLElement, source: BlockSource): void {
    content.replaceChildren();
    appendBlockSourceElement(content, source.atomic ?? source.prefix, "atomic");
}

export function renderPreviewBlockContent(
    content: HTMLElement,
    text: string,
    html: string,
    className: string,
    source: BlockSource = {},
): void {
    content.replaceChildren();
    appendBlockSourceElement(content, source.atomic ?? text, "atomic", className === "markdown-math-preview");

    const preview = document.createElement("div");
    preview.className = className;
    preview.dataset.sourceIgnore = "true";
    preview.contentEditable = "false";
    preview.innerHTML = html;
    content.append(preview);
}

export function renderBlockSourceHtml(value: string | undefined, position: BlockSourcePosition): string {
    if (!value) {
        return "";
    }

    return `<span class="${getBlockSourceClassName(position)}" data-source-ignore="true" spellcheck="false">${escapeHtml(value)}</span>`;
}

export function getBlockSourceElement(content: HTMLElement, position: BlockSourcePosition): HTMLElement | null {
    return content.querySelector<HTMLElement>(`.format-block-source-${position}`);
}

export function readBlockSourcePosition(source: HTMLElement): BlockSourcePosition | null {
    if (source.classList.contains("format-block-source-prefix")) {
        return "prefix";
    }

    if (source.classList.contains("format-block-source-suffix")) {
        return "suffix";
    }

    if (source.classList.contains("format-block-source-atomic")) {
        return "atomic";
    }

    return null;
}

export function isBlockSourceElement(node: Node): node is HTMLElement {
    return node instanceof HTMLElement && node.classList.contains("format-block-source");
}

function appendBlockSourceElement(
    content: HTMLElement,
    value: string | undefined,
    position: BlockSourcePosition,
    allowEmpty = false,
): void {
    if (!value && !allowEmpty) {
        return;
    }

    const source = document.createElement("span");
    source.className = getBlockSourceClassName(position);
    source.dataset.sourceIgnore = "true";
    source.spellcheck = false;
    source.textContent = value ?? "";
    content.append(source);
}

function appendCodeBlockBodyElement(content: HTMLElement, text: string): void {
    const body = document.createElement("span");
    body.className = "markdown-code-block-body";
    body.spellcheck = false;
    body.append(document.createTextNode(renderCodeBlockBodyText(text)));
    content.append(body);
}

function renderCodeBlockBodyText(text: string): string {
    return text.endsWith("\n") ? `${text}${caretSpacerCharacter}` : text;
}

function renderPlainTextContentText(text: string): string {
    return text.endsWith("\n") ? `${text}${caretSpacerCharacter}` : text;
}

function getBlockSourceClassName(position: BlockSourcePosition): string {
    return [
        "format-block-source",
        `format-block-source-${position}`,
    ].join(" ");
}
