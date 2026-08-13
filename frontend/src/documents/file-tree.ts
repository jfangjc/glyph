import { chooseDirectoryToOpen, readDirectoryTree } from "../bridge/documents";
import type { DirectoryTree, DirectoryTreeItem } from "../bridge/types";
import { createCenteredFrame } from "../ui/centered-frame";
import { documentState } from "./document-state";
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
let treeContextElement: HTMLElement | null = null;
let treeContextNameElement: HTMLElement | null = null;
let directoryRequestId = 0;
let treeSignature = "";
let directoryPollTimer = 0;
let directoryPollingGeneration = 0;
let consecutiveDirectoryRefreshFailures = 0;
const collapsedDirectories = new Set<string>();
const lastOpenDirectoryPathStorageKey = "glyph:last-open-directory-path";
const maxSearchResults = 500;
const directoryPollIntervalMs = 1_000;
const maxDirectoryRefreshFailures = 2;

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
    search.autocomplete = "off";
    search.spellcheck = false;
    search.setAttribute("aria-label", "Search files");
    search.setAttribute("aria-describedby", "file-tree-search-hint");

    const searchHint = document.createElement("kbd");
    searchHint.id = "file-tree-search-hint";
    searchHint.className = "file-tree-search-hint";
    searchHint.textContent = "Esc";

    const searchSurface = document.createElement("div");
    searchSurface.className = "file-tree-search-surface";
    searchSurface.append(search, searchHint);

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

    const resultsSurface = document.createElement("div");
    resultsSurface.className = "file-tree-results";
    resultsSurface.append(resultsContext, treeRoot);

    frame.content.append(searchSurface, resultsSurface);
    root.append(frame.element);

    const closeFrame = (): void => {
        stopDirectoryPolling();
        frame.hide(() => clearSearch(treeRoot, search));
    };

    const chooseAndOpenDirectory = async (): Promise<void> => {
        const selectedDirectoryPath = await chooseDirectoryToOpen();
        if (!selectedDirectoryPath) {
            if (frame.isOpen()) {
                search.focus({ preventScroll: true });
            }
            return;
        }

        await openDirectoryPath(selectedDirectoryPath, treeRoot, search);
        frame.show();
        search.focus({ preventScroll: true });
        startDirectoryPolling();
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
        activateSelectedItem(treeRoot, path, closeFrame);
    });

    renderTree(treeRoot);

    return {
        openDirectory: chooseAndOpenDirectory,
        toggle: () => {
            if (frame.isOpen()) {
                closeFrame();
                return;
            }

            frame.show();
            search.focus({ preventScroll: true });
            startDirectoryPolling();
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

async function refreshOpenDirectoryTree(): Promise<void> {
    if (!tree?.path || !treeRootElement) {
        return;
    }

    const requestId = ++directoryRequestId;
    const path = tree.path;
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
        consecutiveDirectoryRefreshFailures += 1;
        if (consecutiveDirectoryRefreshFailures >= maxDirectoryRefreshFailures) {
            clearRemovedDirectoryTree();
            return;
        }
        console.error("Failed to refresh file tree:", error);
    }
}

async function openDirectoryPath(path: string, treeRoot: HTMLElement, search?: HTMLInputElement): Promise<void> {
    stopDirectoryPolling();
    const requestId = ++directoryRequestId;
    const nextTree = await readDirectoryTree(path);
    if (requestId !== directoryRequestId) {
        return;
    }
    tree = nextTree;
    treeSignature = createDirectoryTreeSignature(nextTree);
    consecutiveDirectoryRefreshFailures = 0;
    resetCollapsedDirectories();
    query = "";
    selectedPath = null;
    if (search) {
        search.value = "";
    }
    rememberLastOpenDirectoryPath(tree.path);
    renderTree(treeRoot);
}

function startDirectoryPolling(): void {
    stopDirectoryPolling();
    const generation = directoryPollingGeneration;
    void pollOpenDirectory(generation);
}

function stopDirectoryPolling(): void {
    directoryPollingGeneration += 1;
    if (directoryPollTimer) {
        window.clearTimeout(directoryPollTimer);
        directoryPollTimer = 0;
    }
}

async function pollOpenDirectory(generation: number): Promise<void> {
    if (generation !== directoryPollingGeneration || !tree) {
        return;
    }

    await refreshOpenDirectoryTree();
    if (generation !== directoryPollingGeneration || !tree) {
        return;
    }

    directoryPollTimer = window.setTimeout(() => {
        directoryPollTimer = 0;
        void pollOpenDirectory(generation);
    }, directoryPollIntervalMs);
}

function clearRemovedDirectoryTree(): void {
    directoryRequestId += 1;
    stopDirectoryPolling();
    tree = null;
    treeSignature = "";
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
        }
        return;
    }

    if (event.key === "Enter" && selectedPath) {
        event.preventDefault();
        event.stopPropagation();
        activateSelectedItem(treeRoot, selectedPath, closeFrame);
        return;
    }

    if (event.key.toLowerCase() === "o" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
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
    syncTreeContext();
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
