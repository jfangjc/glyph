import { Window } from "@wailsio/runtime";
import { canUseDesktopFileSystem } from "../documents/document-actions";
import { clamp } from "../utils/text";
import type { ZoomShortcut } from "../editor/input/keyboard-shortcuts";

let browserPreviewZoom = 1;

export async function applyZoomShortcut(shortcut: ZoomShortcut): Promise<void> {
    if (canUseDesktopFileSystem()) {
        try {
            if (shortcut === "in") {
                await Window.ZoomIn();
                return;
            }

            if (shortcut === "out") {
                await Window.ZoomOut();
                return;
            }

            await Window.ZoomReset();
            return;
        } catch (error) {
            console.error("Failed to apply window zoom:", error);
        }
    }

    applyBrowserPreviewZoom(shortcut);
}

function applyBrowserPreviewZoom(shortcut: ZoomShortcut): void {
    if (shortcut === "reset") {
        browserPreviewZoom = 1;
    } else {
        browserPreviewZoom += shortcut === "in" ? 0.1 : -0.1;
    }

    browserPreviewZoom = clamp(browserPreviewZoom, 0.7, 1.6);
    document.documentElement.style.setProperty("--glyph-editor-zoom", browserPreviewZoom.toFixed(2));
}
