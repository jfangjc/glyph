import type { DocumentEditorEventContext } from "../../formats/types";
import {
    commitTransientBlock,
    rerenderInlineBlockContent,
    rerenderPlainTextBlockContent,
} from "../blocks/view";
import {
    focusBlockAtOffset,
    getActiveBlock,
    getCurrentBlockOffset,
} from "../selection/caret";
import { isCompositionEvent } from "./keyboard-shortcuts";

export function handleEditorBeforeInput(_event: InputEvent, _options: DocumentEditorEventContext): void {
    // Format adapters own specialized beforeinput behavior.
}

export function handleEditorInput(event: Event, options: DocumentEditorEventContext): void {
    const block = getActiveBlock(event.target);
    if (!block) {
        return;
    }

    commitTransientBlock(block);

    if (isCompositionEvent(event, options.isComposingText)) {
        options.markDocumentDirty();
        return;
    }

    if (renderPlainTextBlockContent(block, getCurrentBlockOffset(block))) {
        options.markEditorDirty();
        return;
    }

    renderBlockContent(block, getCurrentBlockOffset(block));
    options.markEditorDirty();
}

function renderBlockContent(block: HTMLElement, currentOffset: number): void {
    const focusOffset = rerenderInlineBlockContent(block, currentOffset);

    if (focusOffset === null) {
        return;
    }

    focusBlockAtOffset(block, focusOffset);
}

function renderPlainTextBlockContent(block: HTMLElement, currentOffset: number): boolean {
    const focusOffset = rerenderPlainTextBlockContent(block, currentOffset);
    if (focusOffset === null) {
        return false;
    }

    focusBlockAtOffset(block, focusOffset);
    return true;
}
