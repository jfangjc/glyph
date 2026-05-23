import { chooseDirectoryToOpen, readDirectoryTree } from "../bridge/documents";
import type { DirectoryTree, DirectoryTreeItem } from "../bridge/types";
import { createCenteredFrame } from "../ui/centered-frame";

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
const collapsedDirectories = new Set<string>();
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

            tree = await readDirectoryTree(selectedDirectoryPath);
            collapsedDirectories.clear();
            query = "";
            selectedPath = null;
            search.value = "";
            renderTree(treeRoot);
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

    if (!tree) {
        root.innerHTML = `<div class="file-tree-empty">Open a directory with Ctrl+Shift+O</div>`;
        return;
    }

    const state = { rendered: 0, truncated: false };
    const matchCache = new WeakMap<DirectoryTreeItem, boolean>();
    const children = tree.children.map((child) => renderItem(child, 0, matchCache, state)).join("");
    const truncated = state.truncated ? `<div class="file-tree-empty">Keep typing to narrow results</div>` : "";

    root.innerHTML = `<div role="group">${children || `<div class="file-tree-empty">No matching files</div>`}${truncated}</div>`;
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

function renderItem(
    item: DirectoryTreeItem,
    depth: number,
    matchCache: WeakMap<DirectoryTreeItem, boolean>,
    state: { rendered: number; truncated: boolean },
): string {
    if (!matchesQuery(item, matchCache)) {
        return "";
    }

    if (query && state.rendered >= maxSearchResults) {
        state.truncated = true;
        return "";
    }

    const isCollapsed = !query && collapsedDirectories.has(item.path);
    const children =
        item.isDir && !isCollapsed
            ? (item.children ?? []).map((child) => renderItem(child, depth + 1, matchCache, state)).join("")
            : "";
    const disclosure = item.isDir ? (isCollapsed ? ">" : "v") : "";
    const expanded = item.isDir ? ` aria-expanded="${!isCollapsed}"` : "";
    state.rendered += 1;

    return `
        <div class="file-tree-node">
            <button
                class="file-tree-row"
                type="button"
                role="treeitem"
                data-file-tree-path="${escapeHtml(item.path)}"
                data-file-tree-dir="${item.isDir ? "true" : "false"}"
                data-file-tree-selectable="true"
                style="--file-tree-depth: ${depth}"
                ${selectedPath === item.path ? `data-selected="true"` : ""}
                ${expanded}
            >
                <span class="file-tree-disclosure">${disclosure}</span>
                <span class="file-tree-name">${escapeHtml(item.name)}</span>
            </button>
            ${children ? `<div role="group">${children}</div>` : ""}
        </div>
    `;
}

function matchesQuery(item: DirectoryTreeItem, cache: WeakMap<DirectoryTreeItem, boolean>): boolean {
    if (!query) {
        return true;
    }

    const cached = cache.get(item);
    if (cached !== undefined) {
        return cached;
    }

    const matches =
        item.name.toLowerCase().includes(query) ||
        item.path.toLowerCase().includes(query) ||
        (item.isDir && Boolean(item.children?.some((child) => matchesQuery(child, cache))));

    cache.set(item, matches);
    return matches;
}

function activateSelectedItem(root: HTMLElement, path: string, closeFrame: () => void): void {
    const item = root.querySelector<HTMLButtonElement>(`[data-file-tree-path="${cssEscape(path)}"]`);
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

    const items = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-file-tree-selectable="true"]'));
    if (!items.length) {
        selectedPath = null;
        return;
    }

    const currentIndex = selectedPath ? items.findIndex((item) => item.dataset.fileTreePath === selectedPath) : -1;
    const fallbackIndex = direction > 0 ? 0 : items.length - 1;
    const nextIndex = currentIndex >= 0 ? (currentIndex + direction + items.length) % items.length : fallbackIndex;
    selectedPath = items[nextIndex].dataset.fileTreePath ?? null;
    syncSelection(root);
    items[nextIndex].scrollIntoView({ block: "nearest" });
}

function syncSelection(root: HTMLElement): void {
    const items = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-file-tree-path]"));
    let hasSelectedPath = false;

    for (const item of items) {
        const isSelected = Boolean(selectedPath && item.dataset.fileTreePath === selectedPath);
        if (isSelected) {
            item.dataset.selected = "true";
            item.classList.add("is-selected");
        } else {
            delete item.dataset.selected;
            item.classList.remove("is-selected");
        }
        item.setAttribute("aria-selected", isSelected ? "true" : "false");
        if (isSelected) {
            hasSelectedPath = true;
        }
    }

    if (!hasSelectedPath) {
        selectedPath = null;
    }
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

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (character) => {
        switch (character) {
            case "&":
                return "&amp;";
            case "<":
                return "&lt;";
            case ">":
                return "&gt;";
            case '"':
                return "&quot;";
            default:
                return "&#39;";
        }
    });
}

function cssEscape(value: string): string {
    return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}
