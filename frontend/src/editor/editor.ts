import editorHtml from "./editor.html?raw";
import { installEditorController } from "./editor-controller";

export function installEditor(root: HTMLElement): void {
    root.classList.add("editor-shell");
    root.insertAdjacentHTML("beforeend", editorHtml);
    installEditorController();
}
