import { Window } from "@wailsio/runtime";
import { commands, type AppMenuCommand, type CommandMetadata, type EditorCommand } from "../../app/commands";
import { canUseDesktopFileSystem } from "../../documents/document-actions";
import { getActiveDocumentFormat, isMarkdownSourceMode } from "../../documents/document-session";
import { applyZoomShortcut } from "../../app/zoom";
import { canUseWindowPrintRuntime } from "../../platform/runtime";

type AppMenuControllerOptions = {
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
    canExport: () => boolean;
    canExecuteEditorCommand: (command: EditorCommand) => boolean;
    isEditorCommandActive: (command: EditorCommand) => boolean;
    executeEditorCommand: (command: EditorCommand, focusOwner?: Element | null) => Promise<void>;
};

export function createAppMenuController(options: AppMenuControllerOptions) {
    return {
        executeCommand,
        readCommandState,
    };

    function readCommandState(id: AppMenuCommand): { enabled: boolean; active?: boolean } {
        const metadata: CommandMetadata | undefined = commands.find(command => command.id === id);
        const editorCommand = metadata?.editor;
        return {
            enabled: editorCommand ? options.canExecuteEditorCommand(editorCommand)
                : id === "file:export" ? options.canExport()
                : id.startsWith("file:") ? (id === "file:new" || canUseDesktopFileSystem())
                : id === "view:toggle-markdown-source" ? getActiveDocumentFormat().descriptor.id === "markdown"
                : true,
            active: editorCommand && !id.startsWith("edit:") ? options.isEditorCommandActive(editorCommand)
                : id === "view:toggle-markdown-source" ? isMarkdownSourceMode() : undefined,
        };
    }

    function executeCommand(command: AppMenuCommand, focusOwner: Element | null = null): void {
        const metadata: CommandMetadata | undefined = commands.find(item => item.id === command);
        const editorCommand = metadata?.editor;
        if (editorCommand) {
            void options.executeEditorCommand(editorCommand, focusOwner);
            return;
        }

        switch (command) {
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
            case "edit:undo":
            case "edit:redo":
            case "edit:cut":
            case "edit:copy":
            case "edit:paste":
            case "edit:select-all":
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
                assertUnhandledMenuCommand(command);
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
