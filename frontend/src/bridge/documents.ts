import { Call, Dialogs } from "@wailsio/runtime";
import { getDocumentFileFilters } from "../formats/registry";
import type { DocumentFile, ImageFile } from "./types";

const textFileFilters: Dialogs.FileFilter[] = getDocumentFileFilters().map((filter) => ({
    DisplayName: filter.displayName,
    Pattern: filter.patterns.join(";"),
}));

export async function chooseDocumentToOpen(): Promise<string | null> {
    const selection = await Dialogs.OpenFile({
        Title: "Open file",
        ButtonText: "Open",
        CanChooseFiles: true,
        CanChooseDirectories: false,
        AllowsMultipleSelection: false,
        AllowsOtherFiletypes: true,
        Filters: textFileFilters,
    });

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
    });

    return selection || null;
}

export function readDocument(path: string): Promise<DocumentFile> {
    return Call.ByName("glyph/internal/documents.Service.ReadDocument", path) as Promise<DocumentFile>;
}

export function saveDocument(path: string, content: string): Promise<void> {
    return Call.ByName("glyph/internal/documents.Service.SaveDocument", path, content) as Promise<void>;
}

export function renameDocument(oldPath: string, newPath: string): Promise<void> {
    return Call.ByName("glyph/internal/documents.Service.RenameDocument", oldPath, newPath) as Promise<void>;
}

export function readImage(path: string, baseFilePath: string | null): Promise<ImageFile> {
    return Call.ByName("glyph/internal/documents.Service.ReadImage", path, baseFilePath ?? "") as Promise<ImageFile>;
}
