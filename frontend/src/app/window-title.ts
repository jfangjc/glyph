import { Window } from "@wailsio/runtime";
import { canUseDesktopFileSystem } from "../documents/document-actions";
import { documentState } from "../documents/document-state";
import { getElement } from "../utils/dom";
import { fileNameFromPath } from "../utils/text";
import { getDocumentFormatById } from "../formats/registry";

export function syncDocumentWindowTitle(): void {
    const fileName = documentState.fileName || (
        documentState.activeFilePath ? fileNameFromPath(documentState.activeFilePath) : getSuggestedFileName()
    );
    const dirty = documentState.hasUnsavedChanges ? " •" : "";
    const title = `${fileName}${dirty} — Glyph`;

    document.title = title;

    if (canUseDesktopFileSystem()) {
        void Window.SetTitle(title).catch((error) => console.error("Failed to update window title:", error));
    }
}

export function getSuggestedFileName(): string {
    const title = getElement<HTMLInputElement>("document-title").value.trim();
    const baseName = title || documentState.fileName || fileNameFromPath(documentState.activeFilePath ?? "") || "Untitled";
    const safeName = baseName
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
        .replace(/\s+/g, " ")
        .replace(/[. ]+$/g, "")
        .slice(0, 80)
        .trim();

    const stem = safeName || "Untitled";
    const extension = documentState.committedFileName.match(/\.([^./\\\s]+)$/)?.[1]
        ?? getDocumentFormatById(documentState.activeFormatId).descriptor.defaultExtension;
    return stem.toLowerCase().endsWith(`.${extension.toLowerCase()}`) ? stem : `${stem}.${extension}`;
}
