import type { DocumentFormat } from "../../formats/types";
import { savePastedImage } from "../../bridge/documents";
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

type EditorPasteOptions = EditorClipboardOptions & {
    getActiveFilePath: () => string | null;
    ensureDocumentSaved: () => Promise<boolean>;
};

export async function handleEditorPaste(event: ClipboardEvent, options: EditorPasteOptions): Promise<void> {
    const block = getActiveBlock(event.target);
    const image = readClipboardImage(event.clipboardData);

    if (image && block && options.getActiveDocumentFormat().id === "markdown") {
        await handleImagePaste(event, options, block, image);
        return;
    }

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

async function handleImagePaste(
    event: ClipboardEvent,
    options: EditorPasteOptions,
    block: HTMLElement,
    image: File,
): Promise<void> {
    event.preventDefault();

    let activeFilePath = options.getActiveFilePath();
    if (!activeFilePath) {
        const saved = await options.ensureDocumentSaved();
        if (!saved) {
            return;
        }

        activeFilePath = options.getActiveFilePath();
    }

    if (!activeFilePath) {
        return;
    }

    try {
        const dataUrl = await readFileAsDataUrl(image);
        const pastedImage = await savePastedImage(activeFilePath, dataUrl, image.name, image.type);
        commitTransientBlock(block);
        insertPastedText(block, `![${escapeMarkdownImageAlt(image.name)}](${pastedImage.relativePath})`);
        options.markEditorDirty();
    } catch (error) {
        console.error("Failed to paste image:", error);
    }
}

function readClipboardImage(dataTransfer: DataTransfer | null | undefined): File | null {
    if (!dataTransfer) {
        return null;
    }

    for (const item of Array.from(dataTransfer.items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
            return item.getAsFile();
        }
    }

    return Array.from(dataTransfer.files).find((file) => file.type.startsWith("image/")) ?? null;
}

function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => {
            if (typeof reader.result === "string") {
                resolve(reader.result);
            } else {
                reject(new Error("Unable to read image data"));
            }
        });
        reader.addEventListener("error", () => reject(reader.error ?? new Error("Unable to read image data")));
        reader.readAsDataURL(file);
    });
}

function escapeMarkdownImageAlt(value: string): string {
    return value.replace(/\.[^/.\\]+$/, "").replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}
