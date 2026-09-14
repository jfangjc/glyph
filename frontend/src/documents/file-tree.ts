import { chooseDirectoryToOpen, readDirectoryTree } from "../bridge/documents";
import type { DirectoryTree, DirectoryTreeItem } from "../bridge/types";
import { documentState } from "./document-state";
import { renderFileTreeHtml } from "./file-tree-rendering";
import { getFileTreeItem, moveFileTreeSelection, syncFileTreeSelectionChange } from "./file-tree-selection";

type FileTreeHost = {
    openDocumentPath: (path: string) => Promise<void>;
    focusSearch: () => void;
    showFiles: () => void;
};

export type FileTreeController = {
    setQuery: (value: string, defer?: boolean) => void;
    flushQuery: () => void;
    setVisible: (visible: boolean) => void;
    refresh: () => void;
    openDirectory: () => Promise<void>;
};

let host: FileTreeHost | null = null;
let tree: DirectoryTree | null = null;
let query = "";
let selectedPath: string | null = null;
let renderedSelectedPath: string | null = null;
let searchRenderTimer: number | null = null;
let treeRootElement: HTMLElement | null = null;
let treeContextElement: HTMLElement | null = null;
let treeContextNameElement: HTMLElement | null = null;
let directoryRequestId = 0;
let treeSignature = "";
let directoryTreeDirty = false;
let directoryRefreshPromise: Promise<void> | null = null;
let refreshAgainAfterCurrent = false;
let consecutiveDirectoryRefreshFailures = 0;
const collapsedDirectories = new Set<string>();
const lastOpenDirectoryPathStorageKey = "glyph:last-open-directory-path";
const maxSearchResults = 500;
const searchRenderDelayMs = 60;
const maxDirectoryRefreshFailures = 2;
const directoryTreeInvalidatedEvent = "glyph:directory-tree-invalidated";

export function notifyDirectoryTreeChanged(): void {
    window.dispatchEvent(new Event(directoryTreeInvalidatedEvent));
}

export function installFileTree(root: HTMLElement, nextHost: FileTreeHost): FileTreeController {
    host = nextHost;

    let visible = false;

    const contextName = document.createElement("span");
    contextName.className = "file-tree-context-name";

    const resultsContext = document.createElement("div");
    resultsContext.className = "file-tree-results-context";
    resultsContext.hidden = true;
    resultsContext.append(contextName);

    const treeRoot = document.createElement("div");
    treeRoot.className = "file-tree";
    treeRoot.setAttribute("role", "tree");
    treeRootElement = treeRoot;
    treeContextElement = resultsContext;
    treeContextNameElement = contextName;

    root.classList.add("file-tree-results");
    root.append(resultsContext, treeRoot);

    const refreshIfVisible = (): void => {
        if (
            directoryTreeDirty &&
            visible &&
            document.visibilityState === "visible" &&
            document.hasFocus()
        ) {
            void refreshOpenDirectoryTree();
        }
    };

    const chooseAndOpenDirectory = async (): Promise<void> => {
        const selectedDirectoryPath = await chooseDirectoryToOpen();
        if (!selectedDirectoryPath) {
            if (visible) {
                nextHost.focusSearch();
            }
            return;
        }

        await openDirectoryPath(selectedDirectoryPath, treeRoot);
        nextHost.showFiles();
        nextHost.focusSearch();
    };

    treeRoot.addEventListener("keydown", (event) => {
        if (visible) handleFileTreeKeydown(event, treeRoot);
    }, true);

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
            directoryTreeDirty = Boolean(tree);
            return;
        }
        refreshIfVisible();
    });
    window.addEventListener("blur", () => {
        directoryTreeDirty = Boolean(tree);
    });
    window.addEventListener("focus", refreshIfVisible);
    window.addEventListener(directoryTreeInvalidatedEvent, () => {
        directoryTreeDirty = Boolean(tree);
        refreshIfVisible();
    });

    treeRoot.addEventListener("click", (event) => {
        const openDirectoryButton = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>(
            "[data-file-tree-open-directory]",
        );
        if (openDirectoryButton) {
            void chooseAndOpenDirectory();
            return;
        }

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
        activateSelectedItem(treeRoot, path);
    });

    renderTree(treeRoot);

    return {
        setQuery: (value, defer = false) => {
            query = value.trim().toLowerCase();
            selectedPath = null;
            if (defer && tree) scheduleSearchRender(treeRoot);
            else renderTree(treeRoot);
        },
        flushQuery: () => renderPendingSearch(treeRoot),
        openDirectory: chooseAndOpenDirectory,
        setVisible: (nextVisible) => {
            if (visible === nextVisible) return;
            visible = nextVisible;
            if (!visible) {
                directoryTreeDirty = Boolean(tree);
                clearSearch(treeRoot);
            } else if (!tree) {
                treeRoot.setAttribute("aria-busy", "true");
                void restoreLastOpenDirectory().finally(() => treeRoot.removeAttribute("aria-busy"));
            }
        },
        refresh: () => {
            directoryTreeDirty = Boolean(tree);
            refreshIfVisible();
        },
    };
}

async function restoreLastOpenDirectory(): Promise<void> {
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

async function refreshOpenDirectoryTree(): Promise<void> {
    if (!tree?.path || !treeRootElement) {
        return;
    }

    if (directoryRefreshPromise) {
        refreshAgainAfterCurrent = true;
        return directoryRefreshPromise;
    }

    directoryRefreshPromise = refreshDirectoryTreeUntilCurrent();
    try {
        await directoryRefreshPromise;
    } finally {
        directoryRefreshPromise = null;
    }
}

async function refreshDirectoryTreeUntilCurrent(): Promise<void> {
    do {
        refreshAgainAfterCurrent = false;
        await refreshDirectoryTreeOnce();
    } while (refreshAgainAfterCurrent && tree);
}

async function refreshDirectoryTreeOnce(): Promise<void> {
    if (!tree?.path || !treeRootElement) {
        return;
    }

    const requestId = ++directoryRequestId;
    const path = tree.path;
    directoryTreeDirty = false;
    try {
        const previousScrollTop = treeRootElement.scrollTop;
        const nextTree = await readDirectoryTree(path);
        if (requestId !== directoryRequestId) {
            return;
        }
        consecutiveDirectoryRefreshFailures = 0;
        const nextSignature = createDirectoryTreeSignature(nextTree);
        if (nextSignature === treeSignature) {
            return;
        }
        tree = nextTree;
        treeSignature = nextSignature;
        pruneCollapsedDirectories();
        renderTree(treeRootElement);
        treeRootElement.scrollTop = previousScrollTop;
    } catch (error) {
        if (requestId !== directoryRequestId) {
            return;
        }
        directoryTreeDirty = true;
        consecutiveDirectoryRefreshFailures += 1;
        if (consecutiveDirectoryRefreshFailures >= maxDirectoryRefreshFailures) {
            clearRemovedDirectoryTree();
            return;
        }
        console.error("Failed to refresh file tree:", error);
    }
}

async function openDirectoryPath(path: string, treeRoot: HTMLElement): Promise<void> {
    const requestId = ++directoryRequestId;
    const nextTree = await readDirectoryTree(path);
    if (requestId !== directoryRequestId) {
        return;
    }
    tree = nextTree;
    treeSignature = createDirectoryTreeSignature(nextTree);
    directoryTreeDirty = false;
    refreshAgainAfterCurrent = false;
    consecutiveDirectoryRefreshFailures = 0;
    resetCollapsedDirectories();
    query = "";
    selectedPath = null;
    rememberLastOpenDirectoryPath(tree.path);
    renderTree(treeRoot);
}

function clearRemovedDirectoryTree(): void {
    directoryRequestId += 1;
    tree = null;
    treeSignature = "";
    directoryTreeDirty = false;
    refreshAgainAfterCurrent = false;
    query = "";
    selectedPath = null;
    collapsedDirectories.clear();
    forgetLastOpenDirectoryPath();
    if (treeRootElement) {
        renderTree(treeRootElement);
    }
}

function createDirectoryTreeSignature(directoryTree: DirectoryTree): string {
    const parts = [normalizeSignaturePath(directoryTree.path)];
    const appendItems = (items: DirectoryTreeItem[]): void => {
        for (const item of items) {
            parts.push(item.isDir ? "d" : "f", normalizeSignaturePath(item.path));
            if (item.children) {
                appendItems(item.children);
            }
        }
    };
    appendItems(directoryTree.children);
    return parts.join("\0");
}

function normalizeSignaturePath(path: string): string {
    return path.replace(/\\/g, "/");
}

function handleFileTreeKeydown(event: KeyboardEvent, treeRoot: HTMLElement): void {
    if (event.defaultPrevented || event.isComposing || (event.target instanceof Element && !treeRoot.contains(event.target))) {
        return;
    }

    const focusedRow = (event.target as Element | null)?.closest<HTMLButtonElement>("[data-file-tree-selectable=\"true\"]");
    if (focusedRow?.dataset.fileTreePath) selectedPath = focusedRow.dataset.fileTreePath;

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        moveSelection(treeRoot, event.key === "ArrowDown" ? 1 : -1);
        return;
    }

    if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        event.stopPropagation();
        const items = Array.from(treeRoot.querySelectorAll<HTMLButtonElement>('[data-file-tree-selectable="true"]'));
        const item = event.key === "Home" ? items[0] : items[items.length - 1];
        selectedPath = item?.dataset.fileTreePath ?? selectedPath;
        syncSelection(treeRoot);
        item?.focus({ preventScroll: true });
        item?.scrollIntoView({ block: "nearest" });
        return;
    }

    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && selectedPath) {
        const item = getFileTreeItem(treeRoot, selectedPath);
        if (!item) return;
        event.preventDefault();
        event.stopPropagation();
        const isDirectory = item.dataset.fileTreeDir === "true";
        const expanded = item.getAttribute("aria-expanded") === "true";
        if (event.key === "ArrowRight" && isDirectory && !expanded) {
            collapsedDirectories.delete(selectedPath);
            renderTree(treeRoot);
            getFileTreeItem(treeRoot, selectedPath)?.focus({ preventScroll: true });
            return;
        }
        if (event.key === "ArrowRight" && isDirectory && expanded) {
            const child = item.closest(".file-tree-node")?.querySelector<HTMLButtonElement>(
                ':scope > [role="group"] [data-file-tree-selectable="true"]',
            );
            if (child?.dataset.fileTreePath) {
                selectedPath = child.dataset.fileTreePath;
                syncSelection(treeRoot);
                child.focus({ preventScroll: true });
                child.scrollIntoView({ block: "nearest" });
            }
            return;
        }
        if (event.key === "ArrowLeft" && isDirectory && expanded) {
            collapsedDirectories.add(selectedPath);
            renderTree(treeRoot);
            getFileTreeItem(treeRoot, selectedPath)?.focus({ preventScroll: true });
            return;
        }
        const parent = item.closest(".file-tree-node")?.parentElement?.closest(".file-tree-node")
            ?.querySelector<HTMLButtonElement>(":scope > .file-tree-row");
        if (event.key === "ArrowLeft" && parent?.dataset.fileTreePath) {
            selectedPath = parent.dataset.fileTreePath;
            syncSelection(treeRoot);
            parent.focus({ preventScroll: true });
            parent.scrollIntoView({ block: "nearest" });
        }
        return;
    }

    if (event.key === "Enter" && selectedPath) {
        event.preventDefault();
        event.stopPropagation();
        activateSelectedItem(treeRoot, selectedPath);
        return;
    }

}

function renderTree(root: HTMLElement): void {
    if (searchRenderTimer !== null) {
        window.clearTimeout(searchRenderTimer);
        searchRenderTimer = null;
    }

    const revealCurrent = !query && !selectedPath;
    if (revealCurrent) {
        selectedPath = revealCurrentFile(tree?.children ?? []);
    }

    root.innerHTML = renderFileTreeHtml({
        tree,
        query,
        selectedPath,
        collapsedDirectories,
        maxSearchResults,
    });
    renderedSelectedPath = null;
    if (selectedPath && !getFileTreeItem(root, selectedPath)) selectedPath = null;
    selectFirstSearchResult(root);
    syncSelection(root);
    syncTreeContext();
    if (revealCurrent && selectedPath) {
        const path = selectedPath;
        requestAnimationFrame(() => {
            const item = getFileTreeItem(root, path);
            if (selectedPath === path && item?.getClientRects().length) {
                item.scrollIntoView({ block: "nearest", behavior: "instant" });
            }
        });
    }
}

function revealCurrentFile(items: DirectoryTreeItem[]): string | null {
    const current = normalizeSignaturePath(documentState.activeFilePath || "");
    if (!current) return null;
    for (const item of items) {
        if (!item.isDir && normalizeSignaturePath(item.path) === current) return item.path;
        const found = item.isDir ? revealCurrentFile(item.children ?? []) : null;
        if (found) {
            collapsedDirectories.delete(item.path);
            return found;
        }
    }
    return null;
}

function syncTreeContext(): void {
    if (!treeContextElement || !treeContextNameElement) {
        return;
    }

    treeContextElement.hidden = !tree;
    if (!tree) {
        treeContextNameElement.textContent = "";
        treeContextNameElement.removeAttribute("title");
        return;
    }

    treeContextNameElement.textContent = tree.name || tree.path;
    treeContextNameElement.title = tree.path;
}

function activateSelectedItem(root: HTMLElement, path: string): void {
    const item = getFileTreeItem(root, path);
    if (!item || item.dataset.fileTreeSelectable !== "true") {
        return;
    }

    if (item.dataset.fileTreeDir === "true") {
        toggleDirectory(path);
        renderTree(root);
        getFileTreeItem(root, path)?.focus({ preventScroll: true });
        return;
    }

    void openSelectedFile(path);
}

function moveSelection(root: HTMLElement, direction: 1 | -1): void {
    renderPendingSearch(root);

    selectedPath = moveFileTreeSelection(root, selectedPath, direction);
    syncSelection(root);
    if (selectedPath) getFileTreeItem(root, selectedPath)?.focus({ preventScroll: true });
}

function syncSelection(root: HTMLElement): void {
    selectedPath = syncFileTreeSelectionChange(root, selectedPath, renderedSelectedPath);
    renderedSelectedPath = selectedPath;
}

function selectFirstSearchResult(root: HTMLElement): void {
    if (selectedPath) {
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
    collapseDirectories(tree?.children ?? []);
}

function pruneCollapsedDirectories(): void {
    if (!tree) {
        collapsedDirectories.clear();
        return;
    }
    const available = new Set<string>();
    const visit = (items: DirectoryTreeItem[]) => {
        for (const item of items) {
            if (item.isDir) {
                available.add(item.path);
                visit(item.children ?? []);
            }
        }
    };
    visit(tree.children);
    for (const path of collapsedDirectories) {
        if (!available.has(path)) {
            collapsedDirectories.delete(path);
        }
    }
}

function collapseDirectories(items: DirectoryTreeItem[]): void {
    for (const item of items) {
        if (!item.isDir) {
            continue;
        }

        collapsedDirectories.add(item.path);
        collapseDirectories(item.children ?? []);
    }
}

async function openSelectedFile(path: string): Promise<void> {
    await getHost().openDocumentPath(path);
    window.dispatchEvent(new Event("glyph:navigation-selected"));
}

function clearSearch(root: HTMLElement): void {
    if (!query && !selectedPath) {
        return;
    }

    query = "";
    selectedPath = null;
    renderTree(root);
}

function scheduleSearchRender(root: HTMLElement): void {
    if (searchRenderTimer !== null) {
        window.clearTimeout(searchRenderTimer);
    }
    searchRenderTimer = window.setTimeout(() => {
        searchRenderTimer = null;
        renderTree(root);
    }, searchRenderDelayMs);
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
