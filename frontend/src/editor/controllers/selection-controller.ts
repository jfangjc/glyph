import type {
    DocumentEditorEventContext,
    DocumentEditorHooks,
    DocumentEditorSelectionState,
    DocumentFormat,
} from "../../formats/types";
import {
    findBlock,
    getBlockContent,
    getBlockIndex,
} from "../blocks/view";
import {
    syncDocumentOutlineToSelection,
} from "../document-outline";
import {
    focusSourceSelectionTarget,
    getCaretOffset,
    getSelectedBlockRange,
    readCurrentSourceSelectionTarget,
} from "../selection/caret";

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
        if (normalizeSourceSelection(selectionState)) {
            lastSelectionSignature = "";
            return;
        }

        if (selectionState.signature === lastSelectionSignature) {
            return;
        }

        lastSelectionSignature = selectionState.signature;
        options.hooks.syncActiveBlockIndicator(selectionState.focusBlock);
        options.getActiveDocumentFormat().editorBehavior?.selectionChange?.(
            createDocumentEditorEventContext(),
            selectionState,
        );
        syncBlockSourceReveal(selectionState);
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

    function syncBlockSourceReveal(selectionState: DocumentEditorSelectionState): void {
        if (selectionState.isCollapsed) {
            options.hooks.syncBlockSourceReveal(selectionState.focusBlock);
            return;
        }

        options.hooks.syncBlockSourceRevealBlocks(selectionState.selectedBlocks);
    }
}

type SelectionStateWithSignature = DocumentEditorSelectionState & {
    signature: string;
};

function readSelectionState(): SelectionStateWithSignature {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0) {
        return {
            signature: "none",
            selection: null,
            isCollapsed: true,
            anchorNode: null,
            focusNode: null,
            anchorOffset: 0,
            focusOffset: 0,
            anchorBlock: null,
            focusBlock: null,
            anchorBlockOffset: null,
            focusBlockOffset: null,
            selectedBlocks: [],
            sourceTarget: null,
        };
    }

    const selectedRange = getSelectedBlockRange();
    const sourceTarget = readCurrentSourceSelectionTarget();
    const anchorBlock = findBlock(selection.anchorNode ?? null);
    const focusBlock = findBlock(selection.focusNode ?? null);
    const anchorBlockOffset = readSelectionBoundaryOffset(anchorBlock, selection.anchorNode, selection.anchorOffset);
    const focusBlockOffset = readSelectionBoundaryOffset(focusBlock, selection.focusNode, selection.focusOffset);
    const selectedBlocks = selection.isCollapsed
        ? []
        : selectedRange?.blocks ?? readSelectedBoundaryBlocks(anchorBlock, focusBlock);
    const signature = [
        selection.isCollapsed ? "caret" : "range",
        anchorBlock ? getBlockIndex(anchorBlock) : -1,
        focusBlock ? getBlockIndex(focusBlock) : -1,
        anchorBlockOffset,
        focusBlockOffset,
        sourceTarget ? sourceTarget.kind : "content",
        sourceTarget ? readSourceTargetSignature(sourceTarget) : "",
        sourceTarget ? sourceTarget.sourceOffset : "",
    ].join(":");

    return {
        signature,
        selection,
        isCollapsed: selection.isCollapsed,
        anchorNode: selection.anchorNode,
        focusNode: selection.focusNode,
        anchorOffset: selection.anchorOffset,
        focusOffset: selection.focusOffset,
        anchorBlock,
        focusBlock,
        anchorBlockOffset,
        focusBlockOffset,
        selectedBlocks,
        sourceTarget,
    };
}

function readSourceTargetSignature(sourceTarget: DocumentEditorSelectionState["sourceTarget"]): string {
    if (!sourceTarget) {
        return "";
    }

    if (sourceTarget.kind === "block-source") {
        return sourceTarget.sourcePosition;
    }

    return String(
        Array.from(sourceTarget.block.querySelectorAll<HTMLElement>(".markdown-token")).indexOf(sourceTarget.token),
    );
}

function normalizeSourceSelection(selectionState: DocumentEditorSelectionState): boolean {
    const sourceTarget = selectionState.sourceTarget;
    const focusNode = selectionState.focusNode;
    if (
        !selectionState.isCollapsed ||
        sourceTarget?.kind !== "block-source" ||
        !focusNode ||
        focusNode === sourceTarget.source ||
        sourceTarget.source.contains(focusNode)
    ) {
        return false;
    }

    focusSourceSelectionTarget(sourceTarget);
    return true;
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

function readSelectedBoundaryBlocks(
    anchorBlock: HTMLElement | null,
    focusBlock: HTMLElement | null,
): HTMLElement[] {
    return Array.from(new Set([anchorBlock, focusBlock])).filter(
        (block): block is HTMLElement => Boolean(block),
    );
}
