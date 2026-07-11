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
    configureMarkdownSourceController,
} from "./source-controller";
import {
    commitActiveMarkdownTokenSource,
    configureMarkdownTokenController,
    handleEditorClick as handleMarkdownEditorClick,
    handleEditorMouseDown as handleMarkdownEditorMouseDown,
    handleSelectionChange as handleMarkdownSelectionChange,
} from "./token-controller";

export const markdownEditorBehavior: DocumentEditorBehavior = {
    install: installMarkdownEditorBehavior,
    deactivate: (context) => {
        commitActiveMarkdownTokenSource({ refocus: false });
        context.syncActiveBlockIndicator(null);
        context.syncBlockSourceReveal(null);
    },
    beforeInput: handleMarkdownBeforeInput,
    input: handleMarkdownInput,
    keydown: handleMarkdownKeydown,
    mouseDown: handleMarkdownEditorMouseDown,
    click: (event) => {
        handleMarkdownEditorClick(event);
        return true;
    },
    selectionChange: (_context, selection) => {
        handleMarkdownSelectionChange(selection);
        return true;
    },
    copy: handleMarkdownCopy,
    cut: handleMarkdownCut,
    paste: handleMarkdownPaste,
    drop: handleMarkdownDrop,
    beforeSerialize: () => {
        commitActiveMarkdownTokenSource();
    },
};

function installMarkdownEditorBehavior(hooks: DocumentEditorHooks): void {
    configureMarkdownSourceController({
        markEditorDirty: hooks.markEditorDirty,
    });
    configureMarkdownTokenController({
        syncActiveBlockMarkdownSource: () => {},
    });
}
