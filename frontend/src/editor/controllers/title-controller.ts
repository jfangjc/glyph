import { syncDocumentWindowTitle } from "../../app/window-title";
import { documentState, notifyDocumentStateChanged } from "../../documents/document-state";
import { syncEditorDirtyState } from "../../documents/document-session";
import { titleFromFileName } from "../../formats/file-names";
import type { DocumentFormat } from "../../formats/types";
import { getElement } from "../../utils/dom";
import { flushSourceHistoryBatch } from "../core/store";
import { clearSourceReveal } from "../core/projection";
import { reportEditorError } from "../editor-status";

type TitleControllerOptions = {
    getActiveDocumentFormat: () => DocumentFormat;
    isComposingText: () => boolean;
    hasActiveFileWithUnsavedChanges: () => boolean;
    saveDocument: () => Promise<boolean>;
    syncActiveBlockIndicator: (block: HTMLElement | null) => void;
};

export function createTitleController(options: TitleControllerOptions) {
    return {
        handleTitleBeforeInput: () => undefined,
        handleTitleKeydown,
        handleTitleInput,
        handleTitleFocus,
        handleTitleBlur,
    };

    function handleTitleKeydown(event: KeyboardEvent): void {
        if (event.key === "Escape") {
            event.preventDefault();
            const input = getTitleInput();
            documentState.fileName = documentState.committedFileName;
            documentState.fileNameDirty = false;
            input.value = titleFromFileName(documentState.committedFileName);
            input.blur();
            syncEditorDirtyState();
            return;
        }

        if (event.key === "Enter") {
            event.preventDefault();
            if (!commitInputValue()) {
                return;
            }
            notifyDocumentStateChanged();
            syncDocumentWindowTitle();
            void options.saveDocument();
        }
    }

    function handleTitleInput(): void {
        const input = getTitleInput();
        const value = stripCurrentExtension(sanitizeFileNameStem(input.value, false));
        if (value !== input.value) {
            const start = input.selectionStart ?? value.length;
            input.value = value;
            input.setSelectionRange(Math.min(start, value.length), Math.min(start, value.length));
        }
        input.removeAttribute("aria-invalid");
    }

    function handleTitleFocus(): void {
        flushSourceHistoryBatch();
        options.syncActiveBlockIndicator(null);
        clearSourceReveal();
    }

    function handleTitleBlur(): void {
        if (!commitInputValue()) {
            return;
        }
        notifyDocumentStateChanged();
        syncDocumentWindowTitle();
    }

    function commitInputValue(): boolean {
        const input = getTitleInput();
        const stem = sanitizeFileNameStem(input.value, true).trim();
        if (!stem || stem === "." || stem === "..") {
            reportEditorError("Enter a valid filename.");
            input.setAttribute("aria-invalid", "true");
            input.focus();
            return false;
        }

        input.removeAttribute("aria-invalid");
        input.value = stem;
        documentState.fileName = buildFileName(stem);
        documentState.fileNameDirty = documentState.fileName !== documentState.committedFileName;
        syncEditorDirtyState();
        return true;
    }

    function buildFileName(stem: string): string {
        const currentExtension = documentState.committedFileName.match(/\.([^./\\\s]+)$/)?.[1]
            ?? options.getActiveDocumentFormat().descriptor.defaultExtension;
        return `${stem || "Untitled"}.${currentExtension}`;
    }

    function stripCurrentExtension(value: string): string {
        const extension = documentState.committedFileName.match(/\.([^./\\\s]+)$/)?.[1]
            ?? options.getActiveDocumentFormat().descriptor.defaultExtension;
        return value.toLowerCase().endsWith(`.${extension.toLowerCase()}`)
            ? value.slice(0, -(extension.length + 1))
            : value;
    }
}

function getTitleInput(): HTMLInputElement {
    return getElement<HTMLInputElement>("document-title");
}

function sanitizeFileNameStem(value: string, trimTrailing: boolean): string {
    const sanitized = value
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
        .replace(/\s+/g, " ")
        .slice(0, 80);
    return trimTrailing ? sanitized.replace(/[. ]+$/g, "") : sanitized;
}
