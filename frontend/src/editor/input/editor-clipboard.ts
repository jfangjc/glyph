import type { DocumentFormat } from "../../formats/types";
import { commitTransientBlock } from "../blocks/view";
import { getActiveBlock } from "../selection/caret";
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
    const text = event.clipboardData?.getData("text/plain");
    const block = getActiveBlock(event.target);

    if (!text || !block) {
        return;
    }

    event.preventDefault();
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
    writeDocumentContentToClipboard(event.clipboardData, content, options.getActiveDocumentFormat().id);
}

export function handleEditorCut(event: ClipboardEvent, options: EditorClipboardOptions): void {
    const content = readSelectedDocumentContent(options.getActiveDocumentFormat());

    if (content === null || !event.clipboardData) {
        return;
    }

    event.preventDefault();
    writeDocumentContentToClipboard(event.clipboardData, content, options.getActiveDocumentFormat().id);

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
    activeFormatId: string,
): void {
    clipboardData.setData("text/plain", content);

    if (activeFormatId === "markdown") {
        clipboardData.setData("text/markdown", content);
    }
}
