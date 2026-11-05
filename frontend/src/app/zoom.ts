import { clamp } from "../utils/text";
import type { ZoomShortcut } from "./keymap";

let editorZoom = 1;

export async function applyZoomShortcut(shortcut: ZoomShortcut): Promise<void> {
    // The Linux native runtime clamps zoom below 100% and its ZoomOut uses
    // a negative multiplier. Use document zoom consistently on every host.
    if (shortcut === "reset") {
        editorZoom = 1;
    } else {
        editorZoom += shortcut === "in" ? 0.1 : -0.1;
    }

    editorZoom = Math.round(clamp(editorZoom, 0.7, 1.6) * 100) / 100;
    document.documentElement.style.setProperty("--glyph-editor-zoom", editorZoom.toFixed(2));
}
