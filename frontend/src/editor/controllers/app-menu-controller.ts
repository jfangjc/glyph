import { Window } from "@wailsio/runtime";
import { applyZoomShortcut } from "../../app/zoom";
import { canUseWindowPrintRuntime } from "../../platform/runtime";
import type { AppMenuCommandDetail } from "../../platform/window-controls/window-controls";
import type { FindReplaceController } from "../find-replace";
import { redoHistoryChange, undoHistoryChange } from "./undo-controller";

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
    ensureMarkdownExportSaved: () => Promise<boolean>;
    toggleFileTree: () => void;
    isMarkdownDocument: () => boolean;
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
                undoHistoryChange();
                return;
            case "edit:redo":
                redoHistoryChange();
                return;
            case "edit:cut":
                runEditableCommand("cut");
                return;
            case "edit:copy":
                runEditableCommand("copy");
                return;
            case "edit:paste":
                runEditableCommand("paste");
                return;
            case "edit:select-all":
                selectAllFromMenu(options.editor);
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
        if (!options.isMarkdownDocument()) {
            return;
        }

        const saved = await options.ensureMarkdownExportSaved();
        if (!saved) {
            return;
        }

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
            options.editor.focus();
        }
    }

    function syncExportMenuState(): void {
        const exportButton = document.querySelector<HTMLButtonElement>('[data-app-command="file:export"]');
        if (!exportButton) {
            return;
        }

        exportButton.disabled = !options.isMarkdownDocument();
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
    const pendingImages = Array.from(root.querySelectorAll<HTMLImageElement>("img")).filter((image) => !image.complete);
    if (pendingImages.length === 0) {
        return Promise.resolve();
    }

    return Promise.all(
        pendingImages.map(
            (image) =>
                new Promise<void>((resolve) => {
                    const finish = () => resolve();
                    image.addEventListener("load", finish, { once: true });
                    image.addEventListener("error", finish, { once: true });
                }),
        ),
    ).then(() => undefined);
}

function runEditableCommand(command: "cut" | "copy" | "paste"): void {
    document.execCommand(command);
}

function selectAllFromMenu(editor: HTMLElement): void {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement) {
        activeElement.select();
        return;
    }

    editor.focus();
    document.execCommand("selectAll");
}

function assertUnhandledMenuCommand(command: never): never {
    throw new Error(`Unhandled app menu command: ${command}`);
}
