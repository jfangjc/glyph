import { canUseDesktopFileSystem, openDocument } from "../documents/document-actions";
import {
    isNewFileShortcut,
    isOpenDirectoryShortcut,
    isOpenFileShortcut,
    isSaveFileShortcut,
    isToggleFileTreeShortcut,
    readZoomShortcut,
} from "../editor/input/keyboard-shortcuts";
import { syncLinkOpenIntentFromKeyboard } from "../editor/pointer-interactions";
import { applyZoomShortcut } from "./zoom";

type GlobalShortcutOptions = {
    newDocument: () => void | Promise<void>;
    openDirectory: () => void | Promise<void>;
    saveDocument: (promptForPath?: boolean) => void | Promise<void>;
    toggleFileTree: () => void;
};

export function handleGlobalKeydown(event: KeyboardEvent, options: GlobalShortcutOptions): void {
    syncLinkOpenIntentFromKeyboard(event);

    const zoomShortcut = readZoomShortcut(event);
    if (zoomShortcut) {
        event.preventDefault();
        void applyZoomShortcut(zoomShortcut);
        return;
    }

    if (!canUseDesktopFileSystem()) {
        if (isToggleFileTreeShortcut(event)) {
            event.preventDefault();
            options.toggleFileTree();
        }
        return;
    }

    if (isOpenDirectoryShortcut(event)) {
        event.preventDefault();
        void options.openDirectory();
        return;
    }

    if (isNewFileShortcut(event)) {
        event.preventDefault();
        void options.newDocument();
        return;
    }

    if (isToggleFileTreeShortcut(event)) {
        event.preventDefault();
        options.toggleFileTree();
        return;
    }

    if (isOpenFileShortcut(event)) {
        event.preventDefault();
        void openDocument();
        return;
    }

    if (isSaveFileShortcut(event)) {
        event.preventDefault();
        void options.saveDocument(event.shiftKey);
    }
}
