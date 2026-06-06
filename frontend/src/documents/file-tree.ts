import { chooseDirectoryToOpen, readDirectoryTree } from "../bridge/documents";
import type { DirectoryTree, DirectoryTreeItem } from "../bridge/types";
import { createCenteredFrame } from "../ui/centered-frame";
import { documentState, documentStateChangedEvent } from "./document-state";
import { renderFileTreeHtml } from "./file-tree-rendering";
import { getFileTreeItem, moveFileTreeSelection, syncFileTreeSelection } from "./file-tree-selection";

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
let activeFilePathForCollapsedState: string | null = null;
const collapsedDirectories = new Set<string>();
const lastOpenDirectoryPathStorageKey = "glyph:last-open-directory-path";
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
        renderTree(treeRoot);
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

    window.addEventListener(documentStateChangedEvent, () => {
        syncCollapsedDirectoriesToActiveFile(treeRoot);
    });

    treeRoot.addEventListener("click", (event) => {
        const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-file-tree-path]");
        if (!button || button.dataset.fileTreeSelectable !== "true") {
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

            syncCollapsedDirectoriesToActiveFile(treeRoot);
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
        resetCollapsedDirectories();
        renderTree(treeRootElement);
    } catch (error) {
        console.error("Failed to refresh file tree:", error);
    }
}

async function openDirectoryPath(path: string, treeRoot: HTMLElement, search?: HTMLInputElement): Promise<void> {
    tree = await readDirectoryTree(path);
    resetCollapsedDirectories();
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

    if (!query && !selectedPath) {
        selectedPath = documentState.activeFilePath;
    }

    root.innerHTML = renderFileTreeHtml({
        tree,
        query,
        selectedPath,
        collapsedDirectories,
        maxSearchResults,
    });
    selectFirstSearchResult(root);
    syncSelection(root);
}

function activateSelectedItem(root: HTMLElement, path: string, closeFrame: () => void): void {
    const item = getFileTreeItem(root, path);
    if (!item || item.dataset.fileTreeSelectable !== "true") {
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

function selectFirstSearchResult(root: HTMLElement): void {
    if (!query || selectedPath) {
        return;
    }

    selectedPath = root.querySelector<HTMLButtonElement>('[data-file-tree-selectable="true"]')?.dataset.fileTreePath ?? null;
}

function toggleDirectory(path: string): void {
    if (collapsedDirectories.has(path)) {
        collapsedDirectories.delete(path);
    } else {
        collapsedDirectories.add(path);
    }
}

function resetCollapsedDirectories(): void {
    collapsedDirectories.clear();
    activeFilePathForCollapsedState = documentState.activeFilePath;

    if (!tree) {
        return;
    }

    const expandedDirectories = getActiveFileAncestorDirectories(tree.children, documentState.activeFilePath);
    collapseInactiveDirectories(tree.children, expandedDirectories);
}

function collapseInactiveDirectories(items: DirectoryTreeItem[], expandedDirectories: Set<string>): void {
    for (const item of items) {
        if (!item.isDir) {
            continue;
        }

        if (!expandedDirectories.has(item.path)) {
            collapsedDirectories.add(item.path);
            continue;
        }

        collapseInactiveDirectories(item.children ?? [], expandedDirectories);
    }
}

function getActiveFileAncestorDirectories(items: DirectoryTreeItem[], activeFilePath: string | null): Set<string> {
    const ancestors = new Set<string>();
    if (!activeFilePath) {
        return ancestors;
    }

    findActiveFileAncestors(items, normalizePath(activeFilePath), ancestors);
    return ancestors;
}

function findActiveFileAncestors(
    items: DirectoryTreeItem[],
    activeFilePath: string,
    ancestors: Set<string>,
    parentDirectories: string[] = [],
): boolean {
    for (const item of items) {
        const nextParents = item.isDir ? [...parentDirectories, item.path] : parentDirectories;
        if (normalizePath(item.path) === activeFilePath) {
            for (const path of parentDirectories) {
                ancestors.add(path);
            }
            return true;
        }

        if (item.isDir && findActiveFileAncestors(item.children ?? [], activeFilePath, ancestors, nextParents)) {
            return true;
        }
    }

    return false;
}

function normalizePath(path: string): string {
    return path.replace(/\\/g, "/").toLowerCase();
}

function syncCollapsedDirectoriesToActiveFile(root: HTMLElement): void {
    if (documentState.activeFilePath === activeFilePathForCollapsedState) {
        return;
    }

    resetCollapsedDirectories();
    if (!query) {
        selectedPath = documentState.activeFilePath;
        renderTree(root);
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
