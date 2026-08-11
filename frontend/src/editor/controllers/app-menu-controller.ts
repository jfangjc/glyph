import { Window } from "@wailsio/runtime";
import { applyZoomShortcut } from "../../app/zoom";
import { canUseWindowPrintRuntime } from "../../platform/runtime";
import type { AppMenuCommandDetail } from "../../platform/window-controls/window-controls";
import type { FindReplaceController } from "../find-replace";
import type { EditorCommand } from "./editor-input-controller";

export type AppMenuController = {
    handleAppMenuCommand: (event: CustomEvent<AppMenuCommandDetail>) => void;
    syncExportMenuState: () => void;
};

type AppMenuControllerOptions = {
    editor: HTMLElement;
    surface: HTMLElement;
    findReplaceController: FindReplaceController;
    createNewDocument: () => Promise<void>;
    openDocument: () => Promise<void>;
    openDirectory: () => Promise<void>;
    saveDocument: (promptForPath?: boolean) => Promise<void>;
    ensureExportSaved: () => Promise<boolean>;
    toggleFileTree: () => void;
    canExport: () => boolean;
    executeEditorCommand: (command: EditorCommand, focusOwner?: Element | null) => Promise<void>;
};

export function createAppMenuController(options: AppMenuControllerOptions): AppMenuController {
    return {
        handleAppMenuCommand,
        syncExportMenuState,
    };

    function handleAppMenuCommand(event: CustomEvent<AppMenuCommandDetail>): void {
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
                options.findReplaceController.openFind();
                return;
            case "edit:replace":
                options.findReplaceController.openReplace();
                return;
            case "view:toggle-file-tree":
                options.toggleFileTree();
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
                window.alert("Glyph\nA lightweight, minimalistic cross-platform document editor.");
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

    function syncExportMenuState(): void {
        const exportButton = document.querySelector<HTMLButtonElement>('[data-app-command="file:export"]');
        if (!exportButton) {
            return;
        }

        exportButton.disabled = !options.canExport();
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

function assertUnhandledMenuCommand(command: never): never {
    throw new Error(`Unhandled app menu command: ${command}`);
}
