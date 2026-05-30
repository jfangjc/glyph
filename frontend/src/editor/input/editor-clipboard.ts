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

export async function handleEditorPaste(event: ClipboardEvent, options: EditorClipboardOptions): Promise<void> {
    const block = getActiveBlock(event.target);
    const text = event.clipboardData?.getData("text/plain");

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
