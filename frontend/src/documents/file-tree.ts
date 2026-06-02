import { chooseDirectoryToOpen, readDirectoryTree } from "../bridge/documents";
import type { DirectoryTree } from "../bridge/types";
import { createCenteredFrame } from "../ui/centered-frame";
import { renderFileTreeHtml } from "./file-tree-rendering";
import {
    getFileTreeItem,
    moveFileTreeSelection,
    syncFileTreeSelection,
} from "./file-tree-selection";

type FileTreeHost = {
    openDocumentPath: (path: string) => Promise<void>;
};

type FileTreeController = {
    openDirectory: () => Promise<void>;
    toggle: () => void;
};

let host: FileTreeHost | null = null;
let tree: DirectoryTree | null = null;
let query = "";
let selectedPath: string | null = null;
let searchRenderTimer: number | null = null;
let treeRootElement: HTMLElement | null = null;
const collapsedDirectories = new Set<string>();
const lastOpenDirectoryPathStorageKey = "glyph:last-open-directory-path";
const searchRenderDelayMs = 120;
const maxSearchResults = 500;

export function installFileTree(root: HTMLElement, nextHost: FileTreeHost): FileTreeController {
    host = nextHost;

    const frame = createCenteredFrame({
        className: "file-tree-frame",
        label: "File tree",
    });
    const search = document.createElement("input");
    search.className = "file-tree-search";
    search.type = "search";
    search.placeholder = "Search files";
    search.setAttribute("aria-label", "Search files");

    const treeRoot = document.createElement("div");
    treeRoot.className = "file-tree";
    treeRoot.setAttribute("role", "tree");
    treeRootElement = treeRoot;

    frame.content.append(search, treeRoot);
    root.append(frame.element);

    const closeFrame = (): void => {
        frame.hide();
        clearSearch(treeRoot, search);
    };

    search.addEventListener("input", () => {
        query = search.value.trim().toLowerCase();
        selectedPath = null;
        scheduleRenderTree(treeRoot);
    });

    document.addEventListener(
        "keydown",
        (event) => {
            if (frame.isOpen()) {
                handleFileTreeKeydown(event, treeRoot, closeFrame);
            }
        },
        true,
    );

    frame.element.addEventListener("keydown", (event) => {
        handleFileTreeKeydown(event, treeRoot, closeFrame);
    });

    document.addEventListener("mousedown", (event) => {
        if (frame.isOpen() && !frame.element.contains(event.target as Node | null)) {
            closeFrame();
        }
    });

    treeRoot.addEventListener("click", (event) => {
        const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-file-tree-path]");
        if (!button) {
            return;
        }

        const path = button.dataset.fileTreePath;
        if (!path) {
            return;
        }

        selectedPath = path;
        syncSelection(treeRoot);
        activateSelectedItem(treeRoot, path, closeFrame);
    });

    renderTree(treeRoot);

    return {
        openDirectory: async () => {
            const selectedDirectoryPath = await chooseDirectoryToOpen();
            if (!selectedDirectoryPath) {
                return;
            }

            await openDirectoryPath(selectedDirectoryPath, treeRoot, search);
            frame.show();
            search.focus();
        },
        toggle: () => {
            if (frame.isOpen()) {
                closeFrame();
                return;
            }

            frame.show();
            search.focus();
        },
    };
}

export async function restoreLastOpenDirectory(): Promise<void> {
    const path = getLastOpenDirectoryPath();
    if (!path || !treeRootElement) {
        return;
    }

    try {
        await openDirectoryPath(path, treeRootElement);
    } catch (error) {
        forgetLastOpenDirectoryPath();
        console.error("Failed to restore last open directory:", error);
    }
}

export async function refreshOpenDirectoryTree(): Promise<void> {
    if (!tree?.path || !treeRootElement) {
        return;
    }

    try {
        tree = await readDirectoryTree(tree.path);
        renderTree(treeRootElement);
    } catch (error) {
        console.error("Failed to refresh file tree:", error);
    }
}

async function openDirectoryPath(path: string, treeRoot: HTMLElement, search?: HTMLInputElement): Promise<void> {
    tree = await readDirectoryTree(path);
    collapsedDirectories.clear();
    query = "";
    selectedPath = null;
    if (search) {
        search.value = "";
    }
    rememberLastOpenDirectoryPath(tree.path);
    renderTree(treeRoot);
}

function handleFileTreeKeydown(event: KeyboardEvent, treeRoot: HTMLElement, closeFrame: () => void): void {
    if (event.defaultPrevented) {
        return;
    }

    if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeFrame();
        return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        moveSelection(treeRoot, event.key === "ArrowDown" ? 1 : -1);
        return;
    }

    if (event.key === "Enter" && selectedPath) {
        event.preventDefault();
        event.stopPropagation();
        activateSelectedItem(treeRoot, selectedPath, closeFrame);
        return;
    }

    if (event.key.toLowerCase() === "e" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        closeFrame();
    }
}

function renderTree(root: HTMLElement): void {
    if (searchRenderTimer !== null) {
        window.clearTimeout(searchRenderTimer);
        searchRenderTimer = null;
    }

    root.innerHTML = renderFileTreeHtml({
        tree,
        query,
        selectedPath,
        collapsedDirectories,
        maxSearchResults,
    });
    syncSelection(root);
}

function scheduleRenderTree(root: HTMLElement): void {
    if (searchRenderTimer !== null) {
        window.clearTimeout(searchRenderTimer);
    }

    searchRenderTimer = window.setTimeout(() => {
        searchRenderTimer = null;
        renderTree(root);
    }, searchRenderDelayMs);
}

function activateSelectedItem(root: HTMLElement, path: string, closeFrame: () => void): void {
    const item = getFileTreeItem(root, path);
    if (!item) {
        return;
    }

    if (item.dataset.fileTreeDir === "true") {
        toggleDirectory(path);
        renderTree(root);
        return;
    }

    void openSelectedFile(path, closeFrame);
}

function moveSelection(root: HTMLElement, direction: 1 | -1): void {
    renderPendingSearch(root);

    selectedPath = moveFileTreeSelection(root, selectedPath, direction);
    syncSelection(root);
}

function syncSelection(root: HTMLElement): void {
    selectedPath = syncFileTreeSelection(root, selectedPath);
}

function toggleDirectory(path: string): void {
    if (collapsedDirectories.has(path)) {
        collapsedDirectories.delete(path);
    } else {
        collapsedDirectories.add(path);
    }
}

async function openSelectedFile(path: string, closeFrame: () => void): Promise<void> {
    await getHost().openDocumentPath(path);
    closeFrame();
}

function clearSearch(root: HTMLElement, search: HTMLInputElement): void {
    if (!query && !selectedPath && !search.value) {
        return;
    }

    query = "";
    selectedPath = null;
    search.value = "";
    renderTree(root);
}

function renderPendingSearch(root: HTMLElement): void {
    if (searchRenderTimer !== null) {
        renderTree(root);
    }
}

function getHost(): FileTreeHost {
    if (!host) {
        throw new Error("File tree has not been installed");
    }

    return host;
}

function getLastOpenDirectoryPath(): string | null {
    return window.localStorage.getItem(lastOpenDirectoryPathStorageKey);
}

function rememberLastOpenDirectoryPath(path: string): void {
    window.localStorage.setItem(lastOpenDirectoryPathStorageKey, path);
}

function forgetLastOpenDirectoryPath(): void {
    window.localStorage.removeItem(lastOpenDirectoryPathStorageKey);
}
