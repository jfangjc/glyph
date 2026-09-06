import { Call, Dialogs } from "@wailsio/runtime";
import { getDocumentFileFilters } from "../formats/registry";
import type { DirectoryTree, DocumentFile, ImageFile, PastedImageFile, PdfPreviewFile } from "./types";

export type UnsavedDocumentDecision = "save" | "discard" | "cancel";

const textFileFilters: Dialogs.FileFilter[] = getDocumentFileFilters().map((filter) => ({
    DisplayName: filter.displayName,
    Pattern: filter.patterns.join(";"),
}));

const saveChangesButton = "Save";
const discardChangesButton = "Don't Save";
const cancelChangesButton = "Cancel";
let pendingUnsavedDocumentDecision: Promise<UnsavedDocumentDecision> | null = null;

export async function chooseDocumentToOpen(): Promise<string | null> {
    const selection = await Dialogs.OpenFile({
        Title: "Open file",
        ButtonText: "Open",
        CanChooseFiles: true,
        CanChooseDirectories: false,
        AllowsMultipleSelection: false,
        AllowsOtherFiletypes: true,
        Filters: textFileFilters,
    }).catch(ignoreDialogCancellation);

    if (Array.isArray(selection)) {
        return selection[0] ?? null;
    }

    return selection || null;
}

export async function chooseDirectoryToOpen(): Promise<string | null> {
    const selection = await Dialogs.OpenFile({
        Title: "Open directory",
        ButtonText: "Open",
        CanChooseFiles: false,
        CanChooseDirectories: true,
        AllowsMultipleSelection: false,
        AllowsOtherFiletypes: true,
    }).catch(ignoreDialogCancellation);

    if (Array.isArray(selection)) {
        return selection[0] ?? null;
    }

    return selection || null;
}

export async function chooseDocumentToSave(filename: string): Promise<string | null> {
    const selection = await Dialogs.SaveFile({
        Title: "Save file",
        ButtonText: "Save",
        Filename: filename,
        CanCreateDirectories: true,
        AllowsOtherFiletypes: true,
        Filters: textFileFilters,
    }).catch(ignoreDialogCancellation);

    return selection || null;
}

// Wails may reject a cancelled native dialog instead of returning an empty path.
function ignoreDialogCancellation(error: unknown): null {
    const message = error instanceof Error ? error.message : String(error);
    if (/\bcancel(?:led|ed) by user\b/i.test(message)) return null;
    throw error;
}

export async function chooseUnsavedDocumentDecision(): Promise<UnsavedDocumentDecision> {
    if (pendingUnsavedDocumentDecision) {
        return pendingUnsavedDocumentDecision;
    }

    pendingUnsavedDocumentDecision = showUnsavedDocumentPrompt();
    try {
        return await pendingUnsavedDocumentDecision;
    } finally {
        pendingUnsavedDocumentDecision = null;
    }
}

function showUnsavedDocumentPrompt(): Promise<UnsavedDocumentDecision> {
    return new Promise((resolve) => {
        const focusBeforePrompt = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        const dialog = document.createElement("div");
        dialog.className = "unsaved-document-dialog";
        dialog.setAttribute("role", "alertdialog");
        dialog.setAttribute("aria-modal", "true");
        dialog.setAttribute("aria-labelledby", "unsaved-document-dialog-title");
        dialog.setAttribute("aria-describedby", "unsaved-document-dialog-message");

        const panel = document.createElement("section");
        panel.className = "unsaved-document-dialog-panel";

        const title = document.createElement("h2");
        title.id = "unsaved-document-dialog-title";
        title.textContent = "Save changes?";

        const message = document.createElement("p");
        message.id = "unsaved-document-dialog-message";
        message.textContent = "Do you want to save the changes you made to this document?";

        const actions = document.createElement("div");
        actions.className = "unsaved-document-dialog-actions";
        const cancelButton = createUnsavedDocumentButton(cancelChangesButton, "cancel");
        const discardButton = createUnsavedDocumentButton(discardChangesButton, "discard");
        discardButton.classList.add("unsaved-document-dialog-discard");
        const saveButton = createUnsavedDocumentButton(saveChangesButton, "save");
        saveButton.classList.add("unsaved-document-dialog-save");
        saveButton.autofocus = true;
        actions.append(cancelButton, discardButton, saveButton);
        panel.append(title, message, actions);
        dialog.append(panel);

        let settled = false;
        const finish = (decision: UnsavedDocumentDecision): void => {
            if (settled) {
                return;
            }
            settled = true;
            dialog.remove();
            if (focusBeforePrompt?.isConnected) {
                focusBeforePrompt.focus({ preventScroll: true });
            }
            resolve(decision);
        };

        dialog.addEventListener("click", (event) => {
            if (event.target === dialog) {
                finish("cancel");
                return;
            }

            const button = event.target instanceof Element
                ? event.target.closest<HTMLButtonElement>("button[data-unsaved-document-decision]")
                : null;
            const decision = button?.dataset.unsavedDocumentDecision;
            if (decision === "save" || decision === "discard" || decision === "cancel") {
                finish(decision);
            }
        });
        dialog.addEventListener("keydown", (event) => {
            event.stopPropagation();
            if (event.key === "Escape") {
                event.preventDefault();
                finish("cancel");
                return;
            }

            if (event.key !== "Tab") {
                return;
            }

            const buttons = [cancelButton, discardButton, saveButton];
            const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const nextIndex = event.shiftKey
                ? (currentIndex <= 0 ? buttons.length - 1 : currentIndex - 1)
                : (currentIndex >= buttons.length - 1 ? 0 : currentIndex + 1);
            event.preventDefault();
            buttons[nextIndex].focus({ preventScroll: true });
        });

        document.body.append(dialog);
        saveButton.focus({ preventScroll: true });
    });
}

function createUnsavedDocumentButton(
    label: string,
    decision: UnsavedDocumentDecision,
): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.unsavedDocumentDecision = decision;
    button.textContent = label;
    return button;
}

export function readDocument(path: string): Promise<DocumentFile> {
    return Call.ByName("glyph/internal/documents.Service.ReadDocument", path) as Promise<DocumentFile>;
}

export function saveDocument(path: string, content: string): Promise<void> {
    return Call.ByName("glyph/internal/documents.Service.SaveDocument", path, content) as Promise<void>;
}

export function readSiblingPdfPreview(sourcePath: string, forceCompile = false): Promise<PdfPreviewFile> {
    return Call.ByName(
        "glyph/internal/documents.Service.ReadSiblingPdfPreview",
        sourcePath,
        forceCompile,
    ) as Promise<PdfPreviewFile>;
}

export function createUntitledMarkdownDocument(baseFilePath: string): Promise<DocumentFile> {
    return Call.ByName("glyph/internal/documents.Service.CreateUntitledMarkdownDocument", baseFilePath) as Promise<DocumentFile>;
}

export function renameDocument(oldPath: string, newPath: string): Promise<void> {
    return Call.ByName("glyph/internal/documents.Service.RenameDocument", oldPath, newPath) as Promise<void>;
}

export function readDirectoryTree(path: string): Promise<DirectoryTree> {
    return Call.ByName("glyph/internal/documents.Service.ReadDirectoryTree", path) as Promise<DirectoryTree>;
}

export function readImage(path: string, baseFilePath: string | null): Promise<ImageFile> {
    return Call.ByName("glyph/internal/documents.Service.ReadImage", path, baseFilePath ?? "") as Promise<ImageFile>;
}

export function savePastedImage(
    baseFilePath: string,
    dataUrl: string,
    originalName: string,
    mimeType: string,
): Promise<PastedImageFile> {
    return Call.ByName(
        "glyph/internal/documents.Service.SavePastedImage",
        baseFilePath,
        dataUrl,
        originalName,
        mimeType,
    ) as Promise<PastedImageFile>;
}
