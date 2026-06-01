import type { DocumentFormat } from "../../formats/types";
import { commitTransientBlock } from "../blocks/view";
import { findBlock, getBlockContent } from "../blocks/view";
import {
    focusBlockAtOffset,
    getActiveBlock,
    getCaretOffset,
    getCaretPositionFromPoint,
} from "../selection/caret";
import { insertPastedText } from "../blocks/operations";
import {
    deleteSelectedContent,
    readSelectedContent,
} from "../selection/commands";

type EditorClipboardOptions = {
    getActiveDocumentFormat: () => DocumentFormat;
    markEditorDirty: () => void;
};

export function handleEditorPaste(event: ClipboardEvent, options: EditorClipboardOptions): void {
    const block = getActiveBlock(event.target);

    if (!block) {
        return;
    }

    event.preventDefault();
    const text = readDataTransferText(event.clipboardData);
    if (!text) {
        return;
    }

    commitTransientBlock(block);
    insertPastedText(block, text.replace(/\r\n?/g, "\n"));
    options.markEditorDirty();
}

export function handleEditorDragOver(event: DragEvent): void {
    if (!hasSupportedDropData(event.dataTransfer)) {
        return;
    }

    event.preventDefault();
    if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
    }
}

export function handleEditorDrop(event: DragEvent, options: EditorClipboardOptions): void {
    const block = focusDropTarget(event);
    if (!block) {
        return;
    }

    event.preventDefault();
    const text = readDataTransferText(event.dataTransfer);
    if (!text) {
        return;
    }

    commitTransientBlock(block);
    insertPastedText(block, text.replace(/\r\n?/g, "\n"));
    options.markEditorDirty();
}

export function handleEditorCopy(event: ClipboardEvent, options: EditorClipboardOptions): void {
    const content = readSelectedDocumentContent(options.getActiveDocumentFormat());

    if (content === null || !event.clipboardData) {
        return;
    }

    event.preventDefault();
    writeDocumentContentToClipboard(event.clipboardData, content, options.getActiveDocumentFormat());
}

export function handleEditorCut(event: ClipboardEvent, options: EditorClipboardOptions): void {
    const content = readSelectedDocumentContent(options.getActiveDocumentFormat());

    if (content === null || !event.clipboardData) {
        return;
    }

    event.preventDefault();
    writeDocumentContentToClipboard(event.clipboardData, content, options.getActiveDocumentFormat());

    if (deleteSelectedContent()) {
        options.markEditorDirty();
    }
}

function readSelectedDocumentContent(format: DocumentFormat): string | null {
    return readSelectedContent((blocks) => format.serializeDocument("", false, blocks));
}

function writeDocumentContentToClipboard(
    clipboardData: DataTransfer,
    content: string,
    format: DocumentFormat,
): void {
    clipboardData.setData("text/plain", content);

    for (const mimeType of format.clipboardMimeTypes ?? []) {
        clipboardData.setData(mimeType, content);
    }
}

export function readDataTransferText(dataTransfer: DataTransfer | null | undefined): string {
    if (!dataTransfer) {
        return "";
    }

    const plainText = dataTransfer.getData("text/plain");
    if (plainText) {
        return plainText;
    }

    const html = dataTransfer.getData("text/html");
    if (!html) {
        return "";
    }

    return readPlainTextFromHtml(html);
}

function readPlainTextFromHtml(html: string): string {
    const document = new DOMParser().parseFromString(html, "text/html");
    return document.body.textContent ?? "";
}

function hasSupportedDropData(dataTransfer: DataTransfer | null): boolean {
    if (!dataTransfer) {
        return false;
    }

    return (
        Array.from(dataTransfer.types).some((type) => type === "text/plain" || type === "text/html") ||
        Array.from(dataTransfer.items).some((item) => item.kind === "file")
    );
}

function focusDropTarget(event: DragEvent): HTMLElement | null {
    const caretPosition = getCaretPositionFromPoint(event.clientX, event.clientY);
    if (caretPosition) {
        const block = findBlock(caretPosition.node);
        if (block) {
            const content = getBlockContent(block);
            const offset = getCaretOffset(content, caretPosition.node, caretPosition.offset);
            focusBlockAtOffset(block, offset, { scroll: "none" });
            return block;
        }
    }

    return getActiveBlock(event.target);
}
