import { Window } from "@wailsio/runtime";
import { canUseDesktopFileSystem } from "../documents/document-actions";
import { documentState } from "../documents/document-state";
import { getElement } from "../editor/dom-utils";
import { fileNameFromPath } from "../editor/text-utils";

export function syncDocumentWindowTitle(): void {
    const fileName = documentState.activeFilePath
        ? fileNameFromPath(documentState.activeFilePath)
        : getSuggestedFileName();
    const status = readDocumentStatusLabel(canUseDesktopFileSystem());
    const title = status ? `${fileName} - ${status} - Glyph` : `${fileName} - Glyph`;

    document.title = title;

    if (canUseDesktopFileSystem()) {
        void Window.SetTitle(title).catch((error) => console.error("Failed to update window title:", error));
    }
}

export function getSuggestedFileName(): string {
    const title = getElement<HTMLInputElement>("document-title").value.trim();
    const baseName = title || fileNameFromPath(documentState.activeFilePath ?? "") || "Untitled";
    const safeName = baseName
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
        .replace(/\s+/g, " ")
        .replace(/[. ]+$/g, "")
        .slice(0, 80)
        .trim();

    return safeName ? safeName : "Untitled";
}

function readDocumentStatusLabel(canUseFiles: boolean): string {
    if (!canUseFiles) {
        return documentState.hasUnsavedChanges ? "Unsaved preview" : "";
    }

    if (documentState.isSavingDocument) {
        return "Saving...";
    }

    if (documentState.isOpeningDocument) {
        return "Opening...";
    }

    if (documentState.hasUnsavedChanges) {
        return "Unsaved";
    }

    return documentState.activeFilePath ? "" : "Not saved";
}
