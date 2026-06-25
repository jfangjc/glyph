import { caretSpacerCharacter } from "../selection/rendered-content-dom";
import { escapeHtml } from "../../utils/text";

export type BlockSource = {
    prefix?: string;
    prefixEditable?: boolean;
    suffix?: string;
    suffixEditable?: boolean;
    atomic?: string;
    atomicEditable?: boolean;
};

export type BlockSourcePosition = "prefix" | "suffix" | "atomic";

export function renderPlainTextBlockContent(
    content: HTMLElement,
    text: string,
    source: BlockSource,
    highlightedHtml: string | null = null,
): void {
    content.replaceChildren();
    appendBlockSourceElement(content, source.prefix, "prefix", false, source.prefixEditable);
    appendPlainTextBodyElement(content, text, highlightedHtml);
    appendBlockSourceElement(content, source.suffix, "suffix", false, source.suffixEditable);
}

export function renderCodeBlockContent(content: HTMLElement, text: string, source: BlockSource): void {
    content.replaceChildren();
    appendBlockSourceElement(content, source.prefix, "prefix", false, source.prefixEditable);
    appendCodeBlockBodyElement(content, text);
    appendBlockSourceElement(content, source.suffix, "suffix", false, source.suffixEditable);
}

export function renderAtomicBlockContent(content: HTMLElement, source: BlockSource): void {
    content.replaceChildren();
    appendBlockSourceElement(content, source.atomic ?? source.prefix, "atomic", false, source.atomicEditable);
}

export function renderPreviewBlockContent(
    content: HTMLElement,
    text: string,
    html: string,
    className: string,
    source: BlockSource = {},
): void {
    content.replaceChildren();
    appendBlockSourceElement(
        content,
        source.atomic ?? text,
        "atomic",
        className === "markdown-math-preview",
        source.atomicEditable,
    );

    const preview = document.createElement("div");
    preview.className = className;
    preview.dataset.sourceIgnore = "true";
    preview.contentEditable = "false";
    // Format renderers must only return escaped or sanitized HTML.
    preview.innerHTML = html;
    content.append(preview);
}

export function renderBlockSourceHtml(value: string | undefined, position: BlockSourcePosition, editable = true): string {
    if (!value) {
        return "";
    }

    const editableAttribute = ` contenteditable="${editable ? "true" : "false"}"`;
    return `<span class="${getBlockSourceClassName(position)}" data-source-ignore="true" data-block-source="true" data-block-source-position="${position}" data-block-source-editable="${String(editable)}"${editableAttribute} spellcheck="false">${escapeHtml(value)}</span>`;
}

export function getBlockSourceElement(content: HTMLElement, position: BlockSourcePosition): HTMLElement | null {
    return content.querySelector<HTMLElement>(`.format-block-source-${position}`);
}

export function readBlockSourcePosition(source: HTMLElement): BlockSourcePosition | null {
    if (source.dataset.blockSourcePosition === "prefix") {
        return "prefix";
    }

    if (source.dataset.blockSourcePosition === "suffix") {
        return "suffix";
    }

    if (source.dataset.blockSourcePosition === "atomic") {
        return "atomic";
    }

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

export function findBlockSourceElement(node: Node | null): HTMLElement | null {
    const element = node instanceof Element ? node : node?.parentElement;
    return element?.closest<HTMLElement>(".format-block-source") ?? null;
}

export function isEditableBlockSourceElement(source: HTMLElement): boolean {
    return source.dataset.blockSourceEditable !== "false" && source.getAttribute("contenteditable") !== "false";
}

export function focusBlockSourceAtOffset(source: HTMLElement, offset: number): void {
    const selection = document.getSelection();
    const range = document.createRange();
    const position = getPlainTextPosition(source, Math.max(0, offset));

    source.closest<HTMLElement>("#editor")?.focus();
    range.setStart(position.node, position.offset);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
}

export function getBlockSourceOffset(source: HTMLElement, node: Node, offset: number): number {
    return getPlainTextBoundaryOffset(source, node, offset);
}

function appendBlockSourceElement(
    content: HTMLElement,
    value: string | undefined,
    position: BlockSourcePosition,
    allowEmpty = false,
    editable = true,
): void {
    if (!value && !allowEmpty) {
        return;
    }

    const source = document.createElement("span");
    source.className = getBlockSourceClassName(position);
    source.dataset.sourceIgnore = "true";
    source.dataset.blockSource = "true";
    source.dataset.blockSourcePosition = position;
    source.dataset.blockSourceEditable = String(editable);
    source.contentEditable = editable ? "true" : "false";
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

function appendPlainTextBodyElement(content: HTMLElement, text: string, highlightedHtml: string | null): void {
    if (highlightedHtml === null) {
        content.append(document.createTextNode(renderPlainTextContentText(text)));
        return;
    }

    const body = document.createElement("span");
    body.className = "source-highlighted-text";
    body.spellcheck = false;
    body.innerHTML = text.endsWith("\n") ? `${highlightedHtml}${caretSpacerCharacter}` : highlightedHtml;
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

function getPlainTextPosition(root: HTMLElement, offset: number): { node: Node; offset: number } {
    const text = root.firstChild ?? root.appendChild(document.createTextNode(""));
    return { node: text, offset: Math.min(offset, text.textContent?.length ?? 0) };
}

function getPlainTextBoundaryOffset(current: Node, anchorNode: Node, anchorOffset: number): number {
    if (current === anchorNode) {
        if (current.nodeType === Node.TEXT_NODE) {
            return (current.textContent ?? "").slice(0, anchorOffset).length;
        }

        return Array.from(current.childNodes)
            .slice(0, Math.max(0, anchorOffset))
            .reduce((offset, child) => offset + (child.textContent ?? "").length, 0);
    }

    let offset = 0;
    for (const child of Array.from(current.childNodes)) {
        if (child === anchorNode || child.contains(anchorNode)) {
            return offset + getPlainTextBoundaryOffset(child, anchorNode, anchorOffset);
        }

        offset += (child.textContent ?? "").length;
    }

    return offset;
}
