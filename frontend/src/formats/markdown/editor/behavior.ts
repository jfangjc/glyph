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
        handleMarkdownEditorClick(event);
        return true;
    },
    selectionChange: () => {
        handleMarkdownSelectionChange();
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
        syncBlockMarkdownSourceReveal: hooks.syncBlockSourceReveal,
    });
    configureMarkdownTokenController({
        syncActiveBlockIndicator: hooks.syncActiveBlockIndicator,
        syncActiveBlockMarkdownSource,
        syncBlockMarkdownSourceReveal: hooks.syncBlockSourceReveal,
    });
}
