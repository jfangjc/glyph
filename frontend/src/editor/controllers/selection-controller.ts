import {
    findBlock,
} from "../blocks/view";
import {
    clearSourceReveal,
    syncDomSelectionFromState,
    syncStateSelectionFromDom,
} from "../core/projection";
import { getEditorState } from "../core/store";

type SelectionControllerOptions = {
    syncActiveBlockIndicator: (block: HTMLElement | null) => void;
    isComposingText: () => boolean;
};

export function createSelectionController(options: SelectionControllerOptions) {
    let lastSelectionSignature = "";

    return {
        handleEditorSelectionChange,
        refresh,
    };

    function handleEditorSelectionChange(): void {
        if (options.isComposingText()) return;
        syncStateSelectionFromDom();
        const selectionState = readSelectionState();

        if (selectionState.signature === lastSelectionSignature) {
            return;
        }

        lastSelectionSignature = selectionState.signature;
        options.syncActiveBlockIndicator(selectionState.focusBlock);
        if (selectionState.focusBlock) {
            syncDomSelectionFromState({ focus: "preserve" });
        } else {
            clearSourceReveal();
        }
    }

    function refresh(): void {
        lastSelectionSignature = "";
        handleEditorSelectionChange();
    }
}

function readSelectionState() {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0) {
        return {
            signature: "none",
            focusBlock: null,
        };
    }

    const state = getEditorState();
    const focusBlock = findBlock(selection.focusNode ?? null);
    const signature = [
        state.selection.anchor,
        state.selection.head,
        state.selection.source ? "source" : "visual",
        focusBlock?.dataset.blockId ?? "",
    ].join(":");

    return {
        signature,
        focusBlock,
    };
}
