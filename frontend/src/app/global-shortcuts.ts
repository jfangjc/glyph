import { canUseDesktopFileSystem } from "../documents/document-actions";
import { syncLinkOpenIntentFromKeyboard } from "../editor/pointer-interactions";
import { readShortcutCommand } from "./keymap";
import { applyZoomShortcut } from "./zoom";

type GlobalShortcutOptions = {
    openFind: () => void;
    openReplace: () => void;
    newDocument: () => void | Promise<void>;
    openDocument: () => void | Promise<void>;
    openDirectory: () => void | Promise<void>;
    saveDocument: (promptForPath?: boolean) => void | Promise<void>;
    toggleFileTree: () => void;
};

type GlobalShortcutCommand =
    | "file:new"
    | "file:open"
    | "file:open-directory"
    | "file:save"
    | "file:save-as"
    | "edit:find"
    | "edit:replace"
    | "view:toggle-file-tree"
    | "view:zoom-in"
    | "view:zoom-out"
    | "view:zoom-reset";

export function handleGlobalKeydown(event: KeyboardEvent, options: GlobalShortcutOptions): void {
    syncLinkOpenIntentFromKeyboard(event);

    const command = readGlobalShortcutCommand(event);
    if (!command) {
        return;
    }

    event.preventDefault();
    switch (command) {
        case "edit:find":
            options.openFind();
            return;
        case "edit:replace":
            options.openReplace();
            return;
        case "view:zoom-in":
            void applyZoomShortcut("in");
            return;
        case "view:zoom-out":
            void applyZoomShortcut("out");
            return;
        case "view:zoom-reset":
            void applyZoomShortcut("reset");
            return;
        case "view:toggle-file-tree":
            options.toggleFileTree();
            return;
        case "file:open-directory":
            void options.openDirectory();
            return;
        case "file:new":
            void options.newDocument();
            return;
        case "file:open":
            void options.openDocument();
            return;
        case "file:save":
            void options.saveDocument(false);
            return;
        case "file:save-as":
            void options.saveDocument(true);
    }
}

function readGlobalShortcutCommand(event: KeyboardEvent): GlobalShortcutCommand | null {
    const command = readShortcutCommand(event, "global", {
        canUseNativeFileSystem: canUseDesktopFileSystem(),
    });

    switch (command) {
        case "file:new":
        case "file:open":
        case "file:open-directory":
        case "file:save":
        case "file:save-as":
        case "edit:find":
        case "edit:replace":
        case "view:toggle-file-tree":
        case "view:zoom-in":
        case "view:zoom-out":
        case "view:zoom-reset":
            return command;
        default:
            return null;
    }
}
