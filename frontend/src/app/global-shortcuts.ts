import { canUseDesktopFileSystem, openDocument } from "../documents/document-actions";
import {
    isFindShortcut,
    isNewFileShortcut,
    isOpenDirectoryShortcut,
    isOpenFileShortcut,
    isReplaceShortcut,
    isSaveFileShortcut,
    isToggleFileTreeShortcut,
    readZoomShortcut,
} from "../editor/input/keyboard-shortcuts";
import { syncLinkOpenIntentFromKeyboard } from "../editor/pointer-interactions";
import { applyZoomShortcut } from "./zoom";

type GlobalShortcutOptions = {
    openFind: () => void;
    openReplace: () => void;
    newDocument: () => void | Promise<void>;
    openDirectory: () => void | Promise<void>;
    saveDocument: (promptForPath?: boolean) => void | Promise<void>;
    toggleFileTree: () => void;
};

export function handleGlobalKeydown(event: KeyboardEvent, options: GlobalShortcutOptions): void {
    syncLinkOpenIntentFromKeyboard(event);

    if (isFindShortcut(event)) {
        event.preventDefault();
        options.openFind();
        return;
    }

    if (isReplaceShortcut(event)) {
        event.preventDefault();
        options.openReplace();
        return;
    }

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
