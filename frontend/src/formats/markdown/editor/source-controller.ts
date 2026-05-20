import { parseMarkdownFragment } from "../document";
import {
    applyBlockProperties,
    ensureEditableBlockAfter,
    findBlock,
    getBlockContent,
    getBlockText,
    getSiblingBlock,
    setBlockText,
} from "../../../editor/block-view";
import { readBlockType, type ParsedBlock } from "../../../editor/block-model";
import { removeOrMergeBackward, splitBlock } from "../../../editor/block-operations";
import {
    getBlockSourceElement,
    isBlockSourceElement,
    readBlockSourcePosition,
    type BlockSourcePosition,
} from "../../../editor/block-rendering";
import {
    focusBlockAtOffset,
    focusPlainTextElement,
    getCaretOffset,
    getCurrentBlockOffset,
    getPlainTextBoundaryOffset,
    isCaretAtBlockEdge,
} from "../../../editor/caret";
import { readInlineFormatShortcut } from "../../../editor/keyboard-shortcuts";
import { getRenderedContentText } from "../../../editor/rendered-content-dom";
import { hasMarkdownBlockSource } from "../block-source";
import { clearPendingMarkdownTokenNavigation } from "./token-controller";

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

    if (event.key === "Backspace" && removeOrMergeBackwardFromSourceStart(source)) {
        event.preventDefault();
        hooks.markEditorDirty?.();
        return true;
    }

    if (event.key === "Delete" && removeFollowingEmptyParagraphFromCodeSuffix(source)) {
        event.preventDefault();
        hooks.markEditorDirty?.();
        return true;
    }

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
    if (target && hasMarkdownBlockSource(readBlockType(target.dataset.type))) {
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

    return focusElement?.closest<HTMLElement>(".format-block-source") ?? null;
}

export function applyFocusedBlockMarkdownSourceInput(
    source: HTMLElement | null = getFocusedBlockMarkdownSource(),
): boolean {
    const block = findBlock(source);
    if (!source || !block) {
        return false;
    }

    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    const sourceOffset =
        selection?.isCollapsed && focusNode && (focusNode === source || source.contains(focusNode))
            ? getPlainTextBoundaryOffset(source, focusNode, selection.focusOffset)
            : (source.textContent ?? "").length;
    const sourcePosition = readBlockSourcePosition(source);
    const rawOffset = getBlockRawMarkdownOffset(block, sourcePosition, sourceOffset);
    const parsedBlock = parseEditedRawMarkdownBlock(block, getBlockRawMarkdown(block));

    applyBlockProperties(block, parsedBlock);
    setBlockText(block, parsedBlock.text);
    restoreFocusAfterBlockMarkdownSourceInput(block, sourcePosition, sourceOffset, rawOffset);
    return true;
}

export function syncActiveBlockMarkdownSource(focusBlock: HTMLElement | null): void {
    const source = getFocusedBlockMarkdownSource();
    const sourceBlock = findBlock(source);

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
    focusBlock: HTMLElement | null = findBlock(document.getSelection()?.focusNode ?? null),
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

    const offset = getCurrentBlockOffset(block);
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

    const isDeletingCharacter =
        (event.key === "Backspace" && isCaretAtPlainTextEdge(source, "end")) ||
        (event.key === "Delete" && isCaretAtPlainTextEdge(source, "start"));
    if (!isDeletingCharacter) {
        return false;
    }

    source.textContent = "";
    focusPlainTextElement(source, 0);
    applyFocusedBlockMarkdownSourceInput(source);
    return true;
}

function removeOrMergeBackwardFromSourceStart(source: HTMLElement): boolean {
    if (
        !isCaretAtPlainTextEdge(source, "start") ||
        (readBlockSourcePosition(source) !== "prefix" && readBlockSourcePosition(source) !== "atomic")
    ) {
        return false;
    }

    const block = findBlock(source);
    return Boolean(block && removeOrMergeBackward(block));
}

function removeFollowingEmptyParagraphFromCodeSuffix(source: HTMLElement): boolean {
    if (readBlockSourcePosition(source) !== "suffix" || !isCaretAtPlainTextEdge(source, "end")) {
        return false;
    }

    const block = findBlock(source);
    const next = block ? getSiblingBlock(block, "next") : null;
    if (!next || readBlockType(next.dataset.type) !== "paragraph" || getBlockText(next) !== "") {
        return false;
    }

    next.remove();
    return true;
}

function focusBlockMarkdownSource(
    block: HTMLElement,
    position: BlockSourcePosition,
    edge: "start" | "end",
): boolean {
    const source = getBlockSourceElement(getBlockContent(block), position);
    if (!source) {
        return false;
    }

    focusPlainTextElement(source, edge === "start" ? 0 : (source.textContent ?? "").length);
    return true;
}

function splitAfterBlockMarkdownSource(source: HTMLElement): boolean {
    const block = findBlock(source);
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
    const block = findBlock(source);
    if (
        !block ||
        readBlockType(block.dataset.type) !== "code" ||
        readBlockSourcePosition(source) !== "suffix" ||
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
    const suffix = getBlockSourceElement(content, "suffix");

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

function restoreFocusAfterBlockMarkdownSourceInput(
    block: HTMLElement,
    position: BlockSourcePosition | null,
    sourceOffset: number,
    rawOffset: number,
): void {
    const source = position
        ? getBlockSourceElement(getBlockContent(block), position)
        : null;

    if (source) {
        focusPlainTextElement(source, Math.min(sourceOffset, source.textContent?.length ?? 0));
        activeBlockMarkdownSource = {
            block,
            rawBeforeActivation: getBlockRawMarkdown(block),
        };
        return;
    }

    activeBlockMarkdownSource = null;
    focusBlockAtOffset(block, Math.min(rawOffset, getBlockText(block).length), { scroll: "none" });
}

function getBlockRawMarkdownOffset(
    block: HTMLElement,
    position: BlockSourcePosition | null,
    sourceOffset: number,
): number {
    if (position !== "suffix" || readBlockType(block.dataset.type) !== "code") {
        return sourceOffset;
    }

    const source = readCodeBlockSourceParts(block);
    if (!source) {
        return sourceOffset;
    }

    return source.prefix.length + 1 + source.text.length + 1 + sourceOffset;
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
        text += isBlockMarkdownSource(child) ? child.textContent ?? "" : getRenderedContentText(child);
    }

    return text;
}

function getCodeBlockRawMarkdown(block: HTMLElement): string {
    const source = readCodeBlockSourceParts(block);

    return source ? `${source.prefix}\n${source.text}\n${source.suffix}` : getRenderedContentText(getBlockContent(block));
}

function readCodeBlockSourceParts(block: HTMLElement): { prefix: string; text: string; suffix: string } | null {
    const content = getBlockContent(block);
    const prefix = getBlockSourceElement(content, "prefix");
    const body = content.querySelector<HTMLElement>(".markdown-code-block-body");
    const suffix = getBlockSourceElement(content, "suffix");

    if (!prefix || !body || !suffix) {
        return null;
    }

    return {
        prefix: prefix.textContent ?? "",
        text: getRenderedContentText(body),
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
    return isBlockSourceElement(node);
}
