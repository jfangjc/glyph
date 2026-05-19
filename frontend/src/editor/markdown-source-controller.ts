import { getMarkdownText } from "../formats/markdown/dom";
import { parseMarkdownFragment } from "../formats/markdown/document";
import {
    applyBlockProperties,
    ensureEditableBlockAfter,
    getBlockContent,
    getBlockText,
    getSiblingBlock,
    hasBlockMarkdownSource,
    setBlockText,
    type BlockMarkdownSourcePosition,
} from "./block-view";
import { readBlockType, type ParsedBlock } from "./block-model";
import { splitBlock } from "./block-operations";
import {
    focusBlockAtOffset,
    focusPlainTextElement,
    getCaretOffset,
    getPlainTextBoundaryOffset,
    isCaretAtBlockEdge,
} from "./caret";
import { readInlineFormatShortcut } from "./keyboard-shortcuts";
import { clearPendingMarkdownTokenNavigation } from "./markdown-token-controller";

type MarkdownSourceHooks = {
    markEditorDirty?: () => void;
    syncBlockMarkdownSourceReveal?: (block: HTMLElement | null) => void;
};

let hooks: MarkdownSourceHooks = {};
let activeBlockMarkdownSource: { block: HTMLElement; rawBeforeActivation: string } | null = null;

export function configureMarkdownSourceController(nextHooks: MarkdownSourceHooks): void {
    hooks = { ...hooks, ...nextHooks };
}

export function handleBlockMarkdownSourceKeydown(event: KeyboardEvent): boolean {
    const source = getFocusedBlockMarkdownSource();
    if (!source) {
        return false;
    }

    clearPendingMarkdownTokenNavigation();

    if (
        (event.key === "Backspace" && isCaretAtPlainTextEdge(source, "start")) ||
        (event.key === "Delete" && isCaretAtPlainTextEdge(source, "end"))
    ) {
        event.preventDefault();
        return true;
    }

    if (deleteLastBlockMarkdownSourceCharacter(event, source)) {
        event.preventDefault();
        hooks.markEditorDirty?.();
        return true;
    }

    if (event.key === "Enter" && moveCaretAfterCodeBlockSource(source)) {
        event.preventDefault();
        hooks.markEditorDirty?.();
        return true;
    }

    if (event.key === "Enter" && splitAfterBlockMarkdownSource(source)) {
        event.preventDefault();
        hooks.markEditorDirty?.();
        return true;
    }

    if (event.key === "Enter" || readInlineFormatShortcut(event)) {
        event.preventDefault();
    }

    return true;
}

export function moveCaretIntoCodeBlockSourceAtBoundary(event: KeyboardEvent, block: HTMLElement): boolean {
    if (
        readBlockType(block.dataset.type) !== "code" ||
        block.dataset.markdownSourceActive !== "true" ||
        (event.key !== "Backspace" && event.key !== "Delete")
    ) {
        return false;
    }

    if (event.key === "Backspace" && isCaretAtBlockEdge(block, "start")) {
        return focusBlockMarkdownSource(block, "prefix", "end");
    }

    if (event.key === "Delete" && isCaretAtBlockEdge(block, "end")) {
        return focusBlockMarkdownSource(block, "suffix", "start");
    }

    return false;
}

export function moveCaretAfterCodeBlockSourceAtSelection(block: HTMLElement): boolean {
    if (readBlockType(block.dataset.type) !== "code" || !isCaretAfterCodeBlockSuffixSource(block)) {
        return false;
    }

    commitActiveBlockMarkdownSource(null);
    ensureEditableBlockAfter(block);
    focusBlockAtOffset(getSiblingBlock(block, "next") ?? block, 0);
    return true;
}

export function trackVerticalBlockSourceNavigation(event: KeyboardEvent, block: HTMLElement): boolean {
    if (
        (event.key !== "ArrowUp" && event.key !== "ArrowDown") ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
    ) {
        return false;
    }

    const direction = event.key === "ArrowUp" ? "previous" : "next";
    const edge = direction === "previous" ? "start" : "end";
    if (!isCaretAtBlockEdge(block, edge)) {
        return false;
    }

    const target = getSiblingBlock(block, direction);
    if (target && hasBlockMarkdownSource(readBlockType(target.dataset.type))) {
        hooks.syncBlockMarkdownSourceReveal?.(target);

        if (direction === "previous" && getBlockText(block) === "") {
            event.preventDefault();
            focusBlockAtOffset(target, getBlockText(target).length, { scroll: "minimal" });
            return true;
        }
    }

    return false;
}

export function getFocusedBlockMarkdownSource(): HTMLElement | null {
    const focusNode = document.getSelection()?.focusNode;
    const focusElement = focusNode instanceof Element ? focusNode : focusNode?.parentElement;

    return focusElement?.closest<HTMLElement>(".markdown-block-source") ?? null;
}

export function syncActiveBlockMarkdownSource(focusBlock: HTMLElement | null): void {
    const source = getFocusedBlockMarkdownSource();
    const sourceBlock = source ? findBlockFromSource(source) : null;

    if (source && sourceBlock) {
        if (activeBlockMarkdownSource?.block !== sourceBlock) {
            activeBlockMarkdownSource = {
                block: sourceBlock,
                rawBeforeActivation: getBlockRawMarkdown(sourceBlock),
            };
        }
        return;
    }

    commitActiveBlockMarkdownSource(focusBlock);
}

export function commitActiveBlockMarkdownSource(
    focusBlock: HTMLElement | null = findBlockFromSource(document.getSelection()?.focusNode ?? null),
): void {
    const active = activeBlockMarkdownSource;
    activeBlockMarkdownSource = null;

    if (!active?.block.isConnected) {
        return;
    }

    const rawMarkdown = getBlockRawMarkdown(active.block);
    if (rawMarkdown === active.rawBeforeActivation) {
        return;
    }

    applyRawMarkdownToBlock(active.block, rawMarkdown, focusBlock);
}

export function rerenderPlainTextBlockMarkdownSource(block: HTMLElement): boolean {
    if (readBlockType(block.dataset.type) !== "code") {
        return false;
    }

    const content = getBlockContent(block);
    const selection = document.getSelection();
    const offset =
        selection?.focusNode && (selection.focusNode === content || content.contains(selection.focusNode))
            ? getCaretOffset(content, selection.focusNode, selection.focusOffset)
            : getBlockText(block).length;
    const text = getBlockText(block);

    setBlockText(block, text);
    focusBlockAtOffset(block, Math.min(offset, text.length), { scroll: "none" });
    return true;
}

function deleteLastBlockMarkdownSourceCharacter(event: KeyboardEvent, source: HTMLElement): boolean {
    if (event.key !== "Backspace" && event.key !== "Delete") {
        return false;
    }

    const text = source.textContent ?? "";
    if (text.length !== 1) {
        return false;
    }

    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    if (!selection?.isCollapsed || !focusNode || (focusNode !== source && !source.contains(focusNode))) {
        return false;
    }

    const offset = getPlainTextBoundaryOffset(source, focusNode, selection.focusOffset);
    const isDeletingCharacter =
        (event.key === "Backspace" && offset === text.length) || (event.key === "Delete" && offset === 0);
    if (!isDeletingCharacter) {
        return false;
    }

    source.textContent = "";
    focusPlainTextElement(source, 0);
    return true;
}

function focusBlockMarkdownSource(
    block: HTMLElement,
    position: BlockMarkdownSourcePosition,
    edge: "start" | "end",
): boolean {
    const source = getBlockContent(block).querySelector<HTMLElement>(`.markdown-block-source-${position}`);
    if (!source) {
        return false;
    }

    focusPlainTextElement(source, edge === "start" ? 0 : (source.textContent ?? "").length);
    return true;
}

function splitAfterBlockMarkdownSource(source: HTMLElement): boolean {
    const block = findBlockFromSource(source);
    if (!block || readBlockType(block.dataset.type) === "code") {
        return false;
    }

    commitActiveBlockMarkdownSource(null);

    const type = readBlockType(block.dataset.type);
    if (type === "code") {
        focusBlockAtOffset(block, 0, { scroll: "none" });
        return true;
    }

    if (type === "rule") {
        ensureEditableBlockAfter(block);
        focusBlockAtOffset(getSiblingBlock(block, "next") ?? block, 0);
        return true;
    }

    focusBlockAtOffset(block, getBlockText(block).length, { scroll: "none" });
    splitBlock(block);
    return true;
}

function moveCaretAfterCodeBlockSource(source: HTMLElement): boolean {
    const block = findBlockFromSource(source);
    if (
        !block ||
        readBlockType(block.dataset.type) !== "code" ||
        !source.classList.contains("markdown-block-source-suffix") ||
        !isCaretAtPlainTextEdge(source, "end")
    ) {
        return false;
    }

    commitActiveBlockMarkdownSource(null);
    ensureEditableBlockAfter(block);
    focusBlockAtOffset(getSiblingBlock(block, "next") ?? block, 0);
    return true;
}

function isCaretAfterCodeBlockSuffixSource(block: HTMLElement): boolean {
    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    const content = getBlockContent(block);
    const suffix = content.querySelector<HTMLElement>(".markdown-block-source-suffix");

    if (!selection?.isCollapsed || !focusNode || !suffix) {
        return false;
    }

    if (getFocusedBlockMarkdownSource() === suffix) {
        return isCaretAtPlainTextEdge(suffix, "end");
    }

    if (focusNode !== content) {
        return false;
    }

    const suffixIndex = Array.from(content.childNodes).findIndex((child) => child === suffix);
    return suffixIndex >= 0 && selection.focusOffset > suffixIndex;
}

function isCaretAtPlainTextEdge(element: HTMLElement, edge: "start" | "end"): boolean {
    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    if (!selection?.isCollapsed || !focusNode || (focusNode !== element && !element.contains(focusNode))) {
        return false;
    }

    const offset = getPlainTextBoundaryOffset(element, focusNode, selection.focusOffset);
    return edge === "start" ? offset === 0 : offset === (element.textContent ?? "").length;
}

function applyRawMarkdownToBlock(block: HTMLElement, rawMarkdown: string, focusBlock: HTMLElement | null): void {
    const parsedBlock = parseEditedRawMarkdownBlock(block, rawMarkdown);
    const selection = document.getSelection();
    const shouldRestoreFocus = focusBlock === block && selection?.focusNode && !getFocusedBlockMarkdownSource();
    const focusOffset = shouldRestoreFocus
        ? getCaretOffset(getBlockContent(block), selection.focusNode, selection.focusOffset)
        : null;

    applyBlockProperties(block, parsedBlock);
    setBlockText(block, parsedBlock.text);

    if (focusOffset !== null) {
        focusBlockAtOffset(block, Math.min(focusOffset, parsedBlock.text.length), { scroll: "none" });
    }
}

function parseEditedRawMarkdownBlock(block: HTMLElement, rawMarkdown: string): ParsedBlock {
    if (readBlockType(block.dataset.type) === "code") {
        const codeSource = readCodeBlockSourceParts(block);
        if (codeSource && !isValidCodeBlockSource(codeSource)) {
            return {
                type: "paragraph",
                text: serializeInvalidCodeBlockSource(codeSource),
            };
        }
    }

    const parsedBlocks = parseMarkdownFragment(rawMarkdown).blocks;
    return parsedBlocks.length === 1 ? parsedBlocks[0] : { type: "paragraph", text: rawMarkdown };
}

function getBlockRawMarkdown(block: HTMLElement): string {
    if (readBlockType(block.dataset.type) === "code") {
        return getCodeBlockRawMarkdown(block);
    }

    let text = "";

    for (const child of Array.from(getBlockContent(block).childNodes)) {
        text += isBlockMarkdownSource(child) ? child.textContent ?? "" : getMarkdownText(child);
    }

    return text;
}

function getCodeBlockRawMarkdown(block: HTMLElement): string {
    const source = readCodeBlockSourceParts(block);

    return source ? `${source.prefix}\n${source.text}\n${source.suffix}` : getMarkdownText(getBlockContent(block));
}

function readCodeBlockSourceParts(block: HTMLElement): { prefix: string; text: string; suffix: string } | null {
    const content = getBlockContent(block);
    const prefix = content.querySelector<HTMLElement>(".markdown-block-source-prefix");
    const body = content.querySelector<HTMLElement>(".markdown-code-block-body");
    const suffix = content.querySelector<HTMLElement>(".markdown-block-source-suffix");

    if (!prefix || !body || !suffix) {
        return null;
    }

    return {
        prefix: prefix.textContent ?? "",
        text: getMarkdownText(body),
        suffix: suffix.textContent ?? "",
    };
}

function isValidCodeBlockSource(source: { prefix: string; suffix: string }): boolean {
    const opening = source.prefix.trim().match(/^(`{3,}|~{3,})(.*)$/);
    if (!opening) {
        return false;
    }

    const marker = opening[1];
    const closing = source.suffix.trim();
    const markerCharacter = marker[0];

    return (
        closing.length >= marker.length &&
        closing.split("").every((character) => character === markerCharacter)
    );
}

function serializeInvalidCodeBlockSource(source: { prefix: string; text: string; suffix: string }): string {
    const lines = [source.prefix, source.text];
    if (source.suffix !== "") {
        lines.push(source.suffix);
    }

    return lines.join("\n");
}

function isBlockMarkdownSource(node: Node): node is HTMLElement {
    return node instanceof HTMLElement && node.classList.contains("markdown-block-source");
}

function findBlockFromSource(target: EventTarget | Node | null): HTMLElement | null {
    if (!(target instanceof Node)) {
        return null;
    }

    const element = target instanceof Element ? target : target.parentElement;
    return element?.closest("[data-block]") as HTMLElement | null;
}
