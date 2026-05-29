import {
    createBlock,
    findBlock,
    getBlockContent,
    getBlockText,
    getEditorBlocks,
    syncFirstBlockPlaceholder,
} from "./blocks/view";
import { readBlockType } from "./blocks/model";
import {
    focusBlockAtOffset,
    focusPlainTextElement,
    getCaretOffset,
    getCaretPositionFromPoint,
} from "./selection/caret";
import { getBlockSourceElement } from "./blocks/rendering";
import { getElement } from "../utils/dom";
import { clamp } from "../utils/text";

type PointerBlockTarget = {
    block: HTMLElement;
    offset: number;
};

type PointerInteractionHooks = {
    onBlockActivated?: (block: HTMLElement | null) => void;
};

let hooks: PointerInteractionHooks = {};
let gutterHoverBlock: HTMLElement | null = null;
let gutterHoverTimer = 0;
let pointerDownSelectionStart: { x: number; y: number } | null = null;
let isPointerSelecting = false;
let pendingGutterHoverEvent: { x: number; y: number } | null = null;
let pendingGutterHoverFrame = 0;

export function configurePointerInteractions(nextHooks: PointerInteractionHooks): void {
    hooks = { ...hooks, ...nextHooks };
}

export function handleDocumentSurfaceMouseDown(event: MouseEvent): void {
    if (isWindowChromeEvent(event)) {
        return;
    }

    if (event.button !== 0 || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
    }

    pointerDownSelectionStart = { x: event.clientX, y: event.clientY };
    setPointerSelecting(false);

    const target = event.target;
    if (!(target instanceof Element) || shouldLetBrowserHandlePointerTarget(target)) {
        return;
    }

    const pointerTarget = findPointerTargetBlock(target, event.clientX, event.clientY);
    if (!pointerTarget) {
        return;
    }

    event.preventDefault();
    focusPointerTargetBlock(pointerTarget);
}

export function handleEditorMouseDown(event: MouseEvent): void {
    if (isWindowChromeEvent(event)) {
        return;
    }

    if (event.button !== 0 || event.detail < 3 || event.defaultPrevented) {
        return;
    }

    const block = findBlock(event.target);
    if (!block) {
        return;
    }

    event.preventDefault();
    selectBlockContents(block);
    hooks.onBlockActivated?.(block);
}

export function handleDocumentMouseMove(event: MouseEvent): void {
    if (isWindowChromeEvent(event)) {
        return;
    }

    if (!pointerDownSelectionStart || event.buttons !== 1) {
        return;
    }

    const deltaX = Math.abs(event.clientX - pointerDownSelectionStart.x);
    const deltaY = Math.abs(event.clientY - pointerDownSelectionStart.y);
    if (deltaX > 3 || deltaY > 3) {
        setPointerSelecting(true);
    }
}

export function handleDocumentMouseUp(): void {
    pointerDownSelectionStart = null;
    window.requestAnimationFrame(() => {
        const selection = document.getSelection();
        setPointerSelecting(Boolean(selection && !selection.isCollapsed));
    });
}

export function handleDocumentSurfaceMouseMove(event: MouseEvent): void {
    if (isWindowChromeEvent(event)) {
        return;
    }

    syncLinkOpenIntentFromMouse(event);
    requestGutterHover(event);
}

export function handleDocumentSurfaceMouseOver(event: MouseEvent): void {
    if (isWindowChromeEvent(event)) {
        return;
    }

    syncLinkOpenIntentFromMouse(event);
}

export function handleDocumentSurfaceMouseOut(event: MouseEvent): void {
    if (!(event.relatedTarget instanceof Element) || !getElement<HTMLElement>("document-surface").contains(event.relatedTarget)) {
        clearLinkOpenIntent();
    }
}

export function setPointerSelecting(selecting: boolean): void {
    if (isPointerSelecting === selecting) {
        return;
    }

    isPointerSelecting = selecting;
    getElement<HTMLElement>("editor").dataset.selecting = selecting ? "true" : "false";

    if (selecting) {
        clearGutterHoverBlock();
    }
}

export function clearGutterHoverBlock(): void {
    pendingGutterHoverEvent = null;
    if (pendingGutterHoverFrame) {
        window.cancelAnimationFrame(pendingGutterHoverFrame);
        pendingGutterHoverFrame = 0;
    }

    if (gutterHoverTimer) {
        window.clearTimeout(gutterHoverTimer);
        gutterHoverTimer = 0;
    }

    if (!gutterHoverBlock) {
        return;
    }

    delete gutterHoverBlock.dataset.gutterHover;
    gutterHoverBlock = null;
}

export function syncLinkOpenIntentFromKeyboard(event: KeyboardEvent): void {
    getElement<HTMLElement>("editor").dataset.linkOpenIntent = event.ctrlKey || event.metaKey ? "true" : "false";
}

export function clearLinkOpenIntent(): void {
    getElement<HTMLElement>("editor").dataset.linkOpenIntent = "false";
}

function isWindowChromeEvent(event: MouseEvent): boolean {
    return event.target instanceof Element && Boolean(event.target.closest(".app-titlebar"));
}

function shouldLetBrowserHandlePointerTarget(target: Element): boolean {
    if (target.closest(".markdown-table-preview, .markdown-math-preview, .markdown-html-preview")) {
        return false;
    }

    return Boolean(
        target.closest(
            "#document-title, .block-content, .todo-checkbox, button, input, textarea, select, [contenteditable='false']",
        ),
    );
}

function findPointerTargetBlock(target: Element, clientX: number, clientY: number): PointerBlockTarget | null {
    const directBlock = findBlock(target);
    if (directBlock) {
        return {
            block: directBlock,
            offset: getPointerCaretOffset(directBlock, clientX, clientY),
        };
    }

    const pointTarget = document.elementFromPoint(clientX, clientY);
    const pointBlock = pointTarget instanceof Element ? findBlock(pointTarget) : null;
    if (pointBlock) {
        return {
            block: pointBlock,
            offset: getPointerCaretOffset(pointBlock, clientX, clientY),
        };
    }

    const blocks = getEditorBlocks();
    if (blocks.length === 0) {
        return null;
    }

    const firstBlock = blocks[0];
    const firstRect = firstBlock.getBoundingClientRect();
    if (clientY < firstRect.top) {
        return { block: firstBlock, offset: 0 };
    }

    let previousBlock = firstBlock;
    for (const block of blocks) {
        const rect = block.getBoundingClientRect();

        if (clientY >= rect.top && clientY <= rect.bottom) {
            return {
                block,
                offset: getPointerCaretOffset(block, clientX, clientY),
            };
        }

        if (clientY < rect.top) {
            const previousRect = previousBlock.getBoundingClientRect();
            const gapProgress = (clientY - previousRect.bottom) / Math.max(1, rect.top - previousRect.bottom);
            if (gapProgress > 0.55) {
                return { block, offset: 0 };
            }

            return { block: previousBlock, offset: getBlockText(previousBlock).length };
        }

        previousBlock = block;
    }

    const trailingBlock = ensurePointerTrailingParagraph();
    return { block: trailingBlock, offset: 0 };
}

function ensurePointerTrailingParagraph(): HTMLElement {
    const blocks = getEditorBlocks();
    const lastBlock = blocks[blocks.length - 1];

    if (
        lastBlock &&
        readBlockType(lastBlock.dataset.type) === "paragraph" &&
        getBlockText(lastBlock) === ""
    ) {
        return lastBlock;
    }

    const nextBlock = createBlock("paragraph");
    nextBlock.dataset.transient = "true";

    if (lastBlock) {
        lastBlock.after(nextBlock);
    } else {
        getElement<HTMLElement>("editor").append(nextBlock);
    }

    syncFirstBlockPlaceholder();
    return nextBlock;
}

function getPointerCaretOffset(block: HTMLElement, clientX: number, clientY: number): number {
    const content = getBlockContent(block);
    const rect = content.getBoundingClientRect();
    const clampedX = clamp(clientX, rect.left + 1, rect.right - 1);
    const clampedY = clamp(clientY, rect.top + 1, rect.bottom - 1);
    const caretPosition = getCaretPositionFromPoint(clampedX, clampedY);

    if (caretPosition && (caretPosition.node === content || content.contains(caretPosition.node))) {
        return getCaretOffset(content, caretPosition.node, caretPosition.offset);
    }

    if (clientY < rect.top || clientX <= rect.left) {
        return 0;
    }

    return getBlockText(block).length;
}

function focusPointerTargetBlock(pointerTarget: PointerBlockTarget): void {
    if (focusAtomicPreviewSource(pointerTarget)) {
        return;
    }

    focusBlockAtOffset(pointerTarget.block, pointerTarget.offset, { scroll: "minimal" });
}

function focusAtomicPreviewSource(pointerTarget: PointerBlockTarget): boolean {
    const type = readBlockType(pointerTarget.block.dataset.type);
    if (type !== "math" && type !== "html") {
        return false;
    }

    const source = getBlockSourceElement(getBlockContent(pointerTarget.block), "atomic");
    if (!source) {
        return false;
    }

    pointerTarget.block.dataset.blockSourceActive = "true";
    const sourceLength = source.textContent?.length ?? 0;
    focusPlainTextElement(source, pointerTarget.offset <= 0 ? 0 : sourceLength);
    hooks.onBlockActivated?.(pointerTarget.block);
    return true;
}

function requestGutterHover(event: MouseEvent): void {
    pendingGutterHoverEvent = { x: event.clientX, y: event.clientY };

    if (pendingGutterHoverFrame) {
        return;
    }

    pendingGutterHoverFrame = window.requestAnimationFrame(() => {
        pendingGutterHoverFrame = 0;
        const pending = pendingGutterHoverEvent;
        pendingGutterHoverEvent = null;

        if (pending) {
            scheduleGutterHover(pending.x, pending.y);
        }
    });
}

function scheduleGutterHover(clientX: number, clientY: number): void {
    if (isPointerSelecting) {
        clearGutterHoverBlock();
        return;
    }

    const block = findGutterHoverBlock(clientX, clientY);
    if (!block) {
        clearGutterHoverBlock();
        return;
    }

    if (gutterHoverBlock === block) {
        return;
    }

    if (gutterHoverTimer) {
        window.clearTimeout(gutterHoverTimer);
    }

    gutterHoverTimer = window.setTimeout(() => {
        gutterHoverTimer = 0;
        syncGutterHoverBlock(block);
    }, 220);
}

function findGutterHoverBlock(clientX: number, clientY: number): HTMLElement | null {
    if (!isPointerNearGutterBand(clientX)) {
        return null;
    }

    const pointTarget = document.elementFromPoint(clientX + 34, clientY);
    const pointBlock = pointTarget instanceof Element ? findBlock(pointTarget) : null;
    if (pointBlock) {
        return isPointInBlockGutter(pointBlock, clientX, clientY) ? pointBlock : null;
    }

    for (const block of getEditorBlocks()) {
        const blockRect = block.getBoundingClientRect();
        if (clientY < blockRect.top || clientY > blockRect.bottom) {
            continue;
        }

        if (isPointInBlockGutter(block, clientX, clientY)) {
            return block;
        }
    }

    return null;
}

function isPointerNearGutterBand(clientX: number): boolean {
    const editorRect = getElement<HTMLElement>("editor").getBoundingClientRect();
    return clientX >= editorRect.left - 48 && clientX <= editorRect.left + 64;
}

function isPointInBlockGutter(block: HTMLElement, clientX: number, clientY: number): boolean {
    const blockRect = block.getBoundingClientRect();
    if (clientY < blockRect.top || clientY > blockRect.bottom) {
        return false;
    }

    const contentRect = getBlockContent(block).getBoundingClientRect();
    return clientX >= contentRect.left - 34 && clientX <= contentRect.left - 4;
}

function syncGutterHoverBlock(block: HTMLElement | null): void {
    const nextBlock = block?.isConnected ? block : null;
    if (gutterHoverBlock === nextBlock) {
        return;
    }

    clearGutterHoverBlock();
    gutterHoverBlock = nextBlock;

    if (gutterHoverBlock) {
        gutterHoverBlock.dataset.gutterHover = "true";
    }
}

function syncLinkOpenIntentFromMouse(event: MouseEvent): void {
    const target = event.target;
    const hasLinkIntent = target instanceof Element && Boolean(target.closest("a.markdown-link")) && (event.ctrlKey || event.metaKey);

    getElement<HTMLElement>("editor").dataset.linkOpenIntent = hasLinkIntent ? "true" : "false";
}

function selectBlockContents(block: HTMLElement): void {
    const content = getBlockContent(block);
    const selection = document.getSelection();
    const range = document.createRange();

    range.setStart(content, 0);
    range.setEnd(content, content.childNodes.length);
    selection?.removeAllRanges();
    selection?.addRange(range);
    setPointerSelecting(true);
}
