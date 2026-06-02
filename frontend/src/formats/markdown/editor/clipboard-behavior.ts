import { savePastedImage } from "../../../bridge/documents";
import {
    focusBlockAtOffset,
    focusPlainTextElement,
    getActiveBlock,
    getCaretOffset,
    getCaretPositionFromPoint,
    getPlainTextBoundaryOffset,
} from "../../../editor/selection/caret";
import {
    commitTransientBlock,
    findBlock,
    getBlockContent,
} from "../../../editor/blocks/view";
import { insertPastedText } from "../../../editor/blocks/operations";
import { readDataTransferText } from "../../../editor/input/editor-clipboard";
import type {
    DocumentEditorEventContext,
    DocumentPasteContext,
} from "../../types";
import {
    deleteSelectedBlockMarkdownSourceText,
    getFocusedBlockMarkdownSource,
    insertTextIntoFocusedBlockMarkdownSource,
    readSelectedBlockMarkdownSourceText,
} from "./source-controller";

const supportedPastedImageMimeTypes = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

export function handleMarkdownCopy(event: ClipboardEvent, _context: DocumentEditorEventContext): boolean {
    const sourceText = readSelectedBlockMarkdownSourceText();
    if (sourceText === null || !event.clipboardData) {
        return false;
    }

    event.preventDefault();
    writeMarkdownClipboardText(event.clipboardData, sourceText);
    return true;
}

export function handleMarkdownCut(event: ClipboardEvent, context: DocumentEditorEventContext): boolean {
    const sourceText = readSelectedBlockMarkdownSourceText();
    if (sourceText === null || !event.clipboardData) {
        return false;
    }

    event.preventDefault();
    writeMarkdownClipboardText(event.clipboardData, sourceText);
    if (deleteSelectedBlockMarkdownSourceText()) {
        context.markEditorDirty();
    }
    return true;
}

export function handleMarkdownPaste(event: ClipboardEvent, context: DocumentPasteContext): boolean | Promise<boolean> {
    const sourceText = readDataTransferText(event.clipboardData);
    if (sourceText && getFocusedBlockMarkdownSource()) {
        event.preventDefault();
        context.runDiscreteEdit(() => {
            if (insertTextIntoFocusedBlockMarkdownSource(sourceText.replace(/\r\n?/g, "\n"))) {
                context.markEditorDirty();
            }
        });
        return true;
    }

    const block = getActiveBlock(event.target);
    const image = readClipboardImage(event.clipboardData);

    if (!image || !block) {
        return false;
    }

    event.preventDefault();
    return pasteMarkdownImage(context, block, image);
}

export function handleMarkdownDrop(event: DragEvent, context: DocumentPasteContext): boolean | Promise<boolean> {
    const sourceText = readDataTransferText(event.dataTransfer);
    if (sourceText && focusBlockMarkdownSourceDropTarget(event)) {
        event.preventDefault();
        context.runDiscreteEdit(() => {
            if (insertTextIntoFocusedBlockMarkdownSource(sourceText.replace(/\r\n?/g, "\n"))) {
                context.markEditorDirty();
            }
        });
        return true;
    }

    const image = readClipboardImage(event.dataTransfer);
    if (!image) {
        return false;
    }

    const block = focusMarkdownDropTarget(event);
    if (!block) {
        return false;
    }

    event.preventDefault();
    return dropMarkdownImage(context, block, image);
}

async function pasteMarkdownImage(
    context: DocumentPasteContext,
    block: HTMLElement,
    image: File,
): Promise<boolean> {
    return saveMarkdownImage(context, block, image, "paste");
}

async function dropMarkdownImage(context: DocumentPasteContext, block: HTMLElement, image: File): Promise<boolean> {
    return saveMarkdownImage(context, block, image, "drop");
}

async function saveMarkdownImage(
    context: DocumentPasteContext,
    block: HTMLElement,
    image: File,
    operation: "paste" | "drop",
): Promise<boolean> {
    let activeFilePath = context.getActiveFilePath();
    if (!activeFilePath) {
        const saved = await context.ensureDocumentSaved();
        if (!saved) {
            return true;
        }

        activeFilePath = context.getActiveFilePath();
    }

    if (!activeFilePath) {
        return true;
    }

    try {
        const dataUrl = await readFileAsDataUrl(image);
        const pastedImage = await savePastedImage(activeFilePath, dataUrl, image.name, image.type);
        context.runDiscreteEdit(() => {
            commitTransientBlock(block);
            insertPastedText(block, `![${escapeMarkdownImageAlt(image.name)}](${pastedImage.relativePath})`);
            context.markEditorDirty();
        });
    } catch (error) {
        console.error(`Failed to ${operation} image:`, error);
    }

    return true;
}

function readClipboardImage(dataTransfer: DataTransfer | null | undefined): File | null {
    if (!dataTransfer) {
        return null;
    }

    for (const item of Array.from(dataTransfer.items)) {
        if (item.kind === "file" && supportedPastedImageMimeTypes.has(item.type.toLowerCase())) {
            return item.getAsFile();
        }
    }

    return Array.from(dataTransfer.files).find((file) => supportedPastedImageMimeTypes.has(file.type.toLowerCase())) ?? null;
}

function writeMarkdownClipboardText(clipboardData: DataTransfer, text: string): void {
    clipboardData.setData("text/plain", text);
    clipboardData.setData("text/markdown", text);
}

function focusBlockMarkdownSourceDropTarget(event: DragEvent): boolean {
    const target = event.target;
    const source = target instanceof Element ? target.closest<HTMLElement>(".format-block-source") : null;
    if (!source) {
        return false;
    }

    const caretPosition = getCaretPositionFromPoint(event.clientX, event.clientY);
    if (caretPosition && (caretPosition.node === source || source.contains(caretPosition.node))) {
        focusPlainTextElement(source, getPlainTextBoundaryOffset(source, caretPosition.node, caretPosition.offset));
        return true;
    }

    focusPlainTextElement(source, source.textContent?.length ?? 0);
    return true;
}

function focusMarkdownDropTarget(event: DragEvent): HTMLElement | null {
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
