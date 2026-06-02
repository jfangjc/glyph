import type { DocumentEditorEventContext, DocumentEditorHooks, DocumentFormat } from "../../formats/types";
import {
    findBlock,
    getBlockContent,
    getBlockIndex,
} from "../blocks/view";
import {
    syncDocumentOutlineToSelection,
} from "../document-outline";
import { getSelectedBlockRange } from "../selection/caret";
import { getCaretOffset } from "../selection/caret";

export type SelectionController = {
    handleEditorSelectionChange: () => void;
    resetSelectionSignature: () => void;
};

type SelectionControllerOptions = {
    hooks: DocumentEditorHooks;
    getActiveDocumentFormat: () => DocumentFormat;
    isComposingText: () => boolean;
};

export function createSelectionController(options: SelectionControllerOptions): SelectionController {
    let lastSelectionSignature = "";

    return {
        handleEditorSelectionChange,
        resetSelectionSignature,
    };

    function handleEditorSelectionChange(): void {
        const selectionState = readSelectionState();
        if (selectionState.signature === lastSelectionSignature) {
            return;
        }

        lastSelectionSignature = selectionState.signature;
        options.hooks.syncActiveBlockIndicator(selectionState.focusBlock);
        options.getActiveDocumentFormat().editorBehavior?.selectionChange?.(createDocumentEditorEventContext());
        syncSelectedBlockSourceReveal();
        syncDocumentOutlineToSelection();
    }

    function resetSelectionSignature(): void {
        lastSelectionSignature = "";
    }

    function createDocumentEditorEventContext(): DocumentEditorEventContext {
        return {
            ...options.hooks,
            isComposingText: options.isComposingText(),
        };
    }

    function syncSelectedBlockSourceReveal(): void {
        const selectedRange = getSelectedBlockRange();
        if (selectedRange) {
            options.hooks.syncBlockSourceRevealBlocks(selectedRange.blocks);
            return;
        }

        const selection = document.getSelection();
        if (!selection || selection.isCollapsed) {
            return;
        }

        const selectedBlocks = Array.from(
            new Set([findBlock(selection.anchorNode ?? null), findBlock(selection.focusNode ?? null)]),
        ).filter((block): block is HTMLElement => Boolean(block));

        if (selectedBlocks.length > 0) {
            options.hooks.syncBlockSourceRevealBlocks(selectedBlocks);
        }
    }
}

function readSelectionState(): { signature: string; focusBlock: HTMLElement | null } {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0) {
        return { signature: "none", focusBlock: null };
    }

    const anchorBlock = findBlock(selection.anchorNode ?? null);
    const focusBlock = findBlock(selection.focusNode ?? null);
    const anchorOffset = readSelectionBoundaryOffset(anchorBlock, selection.anchorNode, selection.anchorOffset);
    const focusOffset = readSelectionBoundaryOffset(focusBlock, selection.focusNode, selection.focusOffset);
    const signature = [
        selection.isCollapsed ? "caret" : "range",
        anchorBlock ? getBlockIndex(anchorBlock) : -1,
        focusBlock ? getBlockIndex(focusBlock) : -1,
        anchorOffset,
        focusOffset,
    ].join(":");

    return { signature, focusBlock };
}

function readSelectionBoundaryOffset(block: HTMLElement | null, node: Node | null, offset: number): number {
    if (!block || !node) {
        return offset;
    }

    const content = getBlockContent(block);
    if (node !== content && !content.contains(node)) {
        return offset;
    }

    return getCaretOffset(content, node, offset);
}
