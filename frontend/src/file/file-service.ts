import { Call, Dialogs } from "@wailsio/runtime";

export type DocumentFile = {
    path: string;
    name: string;
    content: string;
};

const textFileFilters: Dialogs.FileFilter[] = [
    { DisplayName: "Markdown", Pattern: "*.md;*.markdown" },
    { DisplayName: "Text Documents", Pattern: "*.txt;*.tex;*.org;*.typ" },
];

export async function chooseFileToOpen(): Promise<string | null> {
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

export function readFile(path: string): Promise<DocumentFile> {
    return Call.ByName("main.FileService.ReadFile", path) as Promise<DocumentFile>;
}

export function saveFile(path: string, content: string): Promise<void> {
    return Call.ByName("main.FileService.SaveFile", path, content) as Promise<void>;
}
