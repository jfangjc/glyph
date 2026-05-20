import { canUseDesktopFileSystem, openDocument } from "../documents/document-actions";
import {
    isOpenFileShortcut,
    isSaveFileShortcut,
    readZoomShortcut,
} from "../editor/input/keyboard-shortcuts";
import { syncLinkOpenIntentFromKeyboard } from "../editor/pointer-interactions";
import { applyZoomShortcut } from "./zoom";

type GlobalShortcutOptions = {
    saveDocument: (promptForPath?: boolean) => void | Promise<void>;
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
