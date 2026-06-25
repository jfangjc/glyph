import type {
    DocumentEditorBehavior,
    DocumentEditorHooks,
} from "../../types";
import {
    handleMarkdownCopy,
    handleMarkdownCut,
    handleMarkdownDrop,
    handleMarkdownPaste,
} from "./clipboard-behavior";
import {
    handleMarkdownBeforeInput,
    handleMarkdownInput,
} from "./input-behavior";
import { handleMarkdownKeydown } from "./keyboard-behavior";
import {
    commitActiveBlockMarkdownSource,
    configureMarkdownSourceController,
    handleBlockMarkdownSourceClick,
    syncActiveBlockMarkdownSource,
} from "./source-controller";
import {
    configureMarkdownTokenController,
    handleEditorClick as handleMarkdownEditorClick,
    handleEditorMouseDown as handleMarkdownEditorMouseDown,
    handleSelectionChange as handleMarkdownSelectionChange,
} from "./token-controller";

export const markdownEditorBehavior: DocumentEditorBehavior = {
    install: installMarkdownEditorBehavior,
    beforeInput: handleMarkdownBeforeInput,
    input: handleMarkdownInput,
    keydown: handleMarkdownKeydown,
    mouseDown: handleMarkdownEditorMouseDown,
    click: (event) => {
        if (handleBlockMarkdownSourceClick(event)) {
            return true;
        }

        handleMarkdownEditorClick(event);
        return true;
    },
    selectionChange: (_context, selection) => {
        const sourceTarget = selection.sourceTarget;
        const focusedBlockSource =
            sourceTarget?.kind === "block-source" &&
            selection.focusNode &&
            (selection.focusNode === sourceTarget.source || sourceTarget.source.contains(selection.focusNode))
                ? sourceTarget.source
                : null;
        syncActiveBlockMarkdownSource(selection.focusBlock, focusedBlockSource);
        handleMarkdownSelectionChange(selection);
        return true;
    },
    copy: handleMarkdownCopy,
    cut: handleMarkdownCut,
    paste: handleMarkdownPaste,
    drop: handleMarkdownDrop,
    beforeSerialize: commitActiveBlockMarkdownSource,
};

function installMarkdownEditorBehavior(hooks: DocumentEditorHooks): void {
    configureMarkdownSourceController({
        markEditorDirty: hooks.markEditorDirty,
    });
    configureMarkdownTokenController({
        syncActiveBlockMarkdownSource,
    });
}
