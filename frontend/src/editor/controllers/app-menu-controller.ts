import { Window } from "@wailsio/runtime";
import { applyZoomShortcut } from "../../app/zoom";
import { canUseWindowPrintRuntime } from "../../platform/runtime";
import type { AppMenuCommandDetail } from "../../platform/window-controls/window-controls";
import type { EditorCommand } from "./editor-input-controller";

type AppMenuControllerOptions = {
    editor: HTMLElement;
    surface: HTMLElement;
    openFind: () => void;
    openReplace: () => void;
    createNewDocument: () => Promise<void>;
    openDocument: () => Promise<void>;
    openDirectory: () => Promise<void>;
    saveDocument: (promptForPath?: boolean) => Promise<void>;
    ensureExportSaved: () => Promise<boolean>;
    toggleFileTree: () => void;
    toggleMarkdownEditingMode: () => void;
    canToggleMarkdownEditingMode: () => boolean;
    isMarkdownSourceMode: () => boolean;
    canExport: () => boolean;
    executeEditorCommand: (command: EditorCommand, focusOwner?: Element | null) => Promise<void>;
    canExecuteEditorCommand: (command: EditorCommand) => boolean;
    isEditorCommandActive: (command: EditorCommand) => boolean;
};

export function createAppMenuController(options: AppMenuControllerOptions) {
    return {
        handleAppMenuCommand,
        syncMenuState,
    };

    function handleAppMenuCommand(event: CustomEvent<AppMenuCommandDetail>): void {
        const editorCommand = readEditorCommand(event.detail.command);
        if (editorCommand) {
            void options.executeEditorCommand(editorCommand, event.detail.focusOwner).finally(syncMenuState);
            return;
        }

        switch (event.detail.command) {
            case "file:new":
                void options.createNewDocument();
                return;
            case "file:open":
                void options.openDocument();
                return;
            case "file:open-directory":
                void options.openDirectory();
                return;
            case "file:save":
                void options.saveDocument();
                return;
            case "file:save-as":
                void options.saveDocument(true);
                return;
            case "file:export":
                void exportCurrentDocumentToPdf();
                return;
            case "edit:undo":
                void options.executeEditorCommand("undo", event.detail.focusOwner);
                return;
            case "edit:redo":
                void options.executeEditorCommand("redo", event.detail.focusOwner);
                return;
            case "edit:cut":
                void options.executeEditorCommand("cut", event.detail.focusOwner);
                return;
            case "edit:copy":
                void options.executeEditorCommand("copy", event.detail.focusOwner);
                return;
            case "edit:paste":
                void options.executeEditorCommand("paste", event.detail.focusOwner);
                return;
            case "edit:select-all":
                void options.executeEditorCommand("select-all", event.detail.focusOwner);
                return;
            case "edit:find":
                options.openFind();
                return;
            case "edit:replace":
                options.openReplace();
                return;
            case "view:toggle-file-tree":
                options.toggleFileTree();
                return;
            case "view:toggle-markdown-source":
                options.toggleMarkdownEditingMode();
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
            case "help:about":
                showAboutDialog();
                return;
            case "format:bold":
            case "format:italic":
            case "format:strike":
            case "format:inline-code":
            case "format:link":
            case "format:block:paragraph":
            case "format:block:heading-1":
            case "format:block:heading-2":
            case "format:block:heading-3":
            case "format:block:list":
            case "format:block:ordered-list":
            case "format:block:todo":
            case "format:block:quote":
            case "format:block:code":
            case "insert:table":
            case "insert:image":
            case "insert:math":
            case "insert:rule":
                return;
            default:
                assertUnhandledMenuCommand(event.detail.command);
        }
    }

    async function exportCurrentDocumentToPdf(): Promise<void> {
        if (!options.canExport()) {
            return;
        }

        const saved = await options.ensureExportSaved();
        if (!saved) {
            return;
        }

        const focusOwner = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        try {
            document.body.dataset.printingMarkdown = "true";
            await waitForMarkdownExportView();
            if (canUseWindowPrintRuntime()) {
                await Window.Print();
            } else {
                window.print();
            }
        } catch (error) {
            console.error("Failed to export PDF:", error);
        } finally {
            delete document.body.dataset.printingMarkdown;
            if (focusOwner?.isConnected) {
                focusOwner.focus({ preventScroll: true });
            }
        }
    }

    function syncMenuState(): void {
        const exportButton = document.querySelector<HTMLButtonElement>('[data-app-command="file:export"]');
        if (!exportButton) {
            return;
        }

        exportButton.disabled = !options.canExport();
        const editorCommands: Array<[string, EditorCommand]> = [
            ["edit:undo", "undo"],
            ["edit:redo", "redo"],
            ["edit:cut", "cut"],
            ["edit:copy", "copy"],
            ["edit:paste", "paste"],
            ["edit:select-all", "select-all"],
        ];
        for (const [menuCommand, editorCommand] of editorCommands) {
            const button = document.querySelector<HTMLButtonElement>(`[data-app-command="${menuCommand}"]`);
            if (button) button.disabled = !options.canExecuteEditorCommand(editorCommand);
        }

        const sourceModeButton = document.querySelector<HTMLButtonElement>(
            '[data-app-command="view:toggle-markdown-source"]',
        );
        if (sourceModeButton) {
            sourceModeButton.disabled = !options.canToggleMarkdownEditingMode();
            sourceModeButton.setAttribute("aria-checked", String(options.isMarkdownSourceMode()));
        }

        for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-editor-command]"))) {
            const command = button.dataset.editorCommand as EditorCommand | undefined;
            if (!command) continue;
            button.disabled = !options.canExecuteEditorCommand(command);
            if (button.getAttribute("role") === "menuitemcheckbox" || button.getAttribute("role") === "menuitemradio") {
                button.setAttribute("aria-checked", String(options.isEditorCommandActive(command)));
            }
        }
    }

    async function waitForMarkdownExportView(): Promise<void> {
        await nextAnimationFrame();
        await waitForPreviewImages(options.surface);
        await nextAnimationFrame();
    }
}

function nextAnimationFrame(): Promise<void> {
    return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function waitForPreviewImages(root: HTMLElement): Promise<void> {
    const images = Array.from(root.querySelectorAll<HTMLImageElement>("img"));
    for (const image of images) {
        image.loading = "eager";
    }
    const pendingImages = images.filter((image) => !image.complete);
    if (pendingImages.length === 0) {
        return Promise.resolve();
    }

    const settled = Promise.all(
        pendingImages.map(
            (image) =>
                new Promise<void>((resolve) => {
                    const finish = () => resolve();
                    image.addEventListener("load", finish, { once: true });
                    image.addEventListener("error", finish, { once: true });
                }),
        ),
    ).then(() => undefined);
    const timeout = new Promise<void>((resolve) => window.setTimeout(resolve, 5_000));
    return Promise.race([settled, timeout]);
}

function readEditorCommand(command: AppMenuCommandDetail["command"]): EditorCommand | null {
    if (command === "format:bold") return "bold";
    if (command === "format:italic") return "italic";
    if (command === "format:strike") return "strike";
    if (command === "format:inline-code") return "inline-code";
    if (command === "format:link") return "link";
    if (command.startsWith("format:block:")) {
        return `block:${command.slice("format:block:".length)}` as EditorCommand;
    }
    if (command.startsWith("insert:")) {
        return command as EditorCommand;
    }
    return null;
}

function showAboutDialog(): void {
    let dialog = document.getElementById("about-glyph-dialog") as HTMLDialogElement | null;
    if (!dialog) {
        dialog = document.createElement("dialog");
        dialog.id = "about-glyph-dialog";
        dialog.className = "about-glyph-dialog";
        dialog.setAttribute("aria-labelledby", "about-glyph-title");
        dialog.innerHTML = `
            <form method="dialog">
                <div class="about-glyph-mark" aria-hidden="true">G</div>
                <h2 id="about-glyph-title">Glyph</h2>
                <p>A focused, cross-platform document editor.</p>
                <button type="submit" value="close">Close</button>
            </form>`;
        dialog.addEventListener("click", (event) => {
            if (event.target === dialog) dialog?.close();
        });
        document.body.append(dialog);
    }
    if (!dialog.open) dialog.showModal();
}

function assertUnhandledMenuCommand(command: never): never {
    throw new Error(`Unhandled app menu command: ${command}`);
}
