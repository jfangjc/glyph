import { canUseDesktopFileSystem } from "../documents/document-actions";
import { syncLinkOpenIntentFromKeyboard } from "../editor/pointer-interactions";
import { isShellCommand, readShortcutCommand } from "./keymap";
import type { AppMenuCommand } from "./commands";

export function handleGlobalKeydown(event: KeyboardEvent, executeCommand: (command: AppMenuCommand, focusOwner: Element | null) => void): void {
    if (event.isComposing || event.defaultPrevented) return;
    syncLinkOpenIntentFromKeyboard(event);

    const command = readGlobalShortcutCommand(event);
    if (!command) {
        return;
    }

    event.preventDefault();
    executeCommand(command, document.activeElement);
}

function readGlobalShortcutCommand(event: KeyboardEvent): AppMenuCommand | null {
    const command = readShortcutCommand(event, "global", {
        canUseNativeFileSystem: canUseDesktopFileSystem(),
    });

    // The keymap owns global scope; shell commands are handled during capture
    // by the writing interface before this window listener runs.
    return command && !isShellCommand(command) ? command : null;
}
