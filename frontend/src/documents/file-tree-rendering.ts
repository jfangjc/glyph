import type { DirectoryTree, DirectoryTreeItem } from "../bridge/types";
import { readShortcutLabel } from "../app/keymap";
import { escapeHtml } from "../utils/text";

type FileTreeRenderOptions = {
    tree: DirectoryTree | null;
    query: string;
    selectedPath: string | null;
    collapsedDirectories: Set<string>;
    maxSearchResults: number;
};

const searchableItemText = new WeakMap<DirectoryTreeItem, string>();

export function renderFileTreeHtml(options: FileTreeRenderOptions): string {
    if (!options.tree) {
        const shortcut = readShortcutLabel("file:open-directory");
        return `
            <div class="file-tree-empty">
                <strong class="file-tree-empty-title">No folder open</strong>
                <span class="file-tree-empty-detail">Choose a folder to browse its files.</span>
                <span class="file-tree-empty-actions">
                    <button class="file-tree-empty-action" type="button" data-file-tree-open-directory>Open folder</button>
                    ${shortcut ? `<kbd class="file-tree-shortcut">${escapeHtml(shortcut)}</kbd>` : ""}
                </span>
            </div>
        `;
    }

    const state = { rendered: 0, truncated: false };
    const matchCache = new WeakMap<DirectoryTreeItem, boolean>();
    const children = options.tree.children
        .map((child) => renderItem(child, 0, matchCache, state, options))
        .join("");
    const truncated = state.truncated
        ? `<div class="file-tree-empty file-tree-empty--message">Keep typing to narrow results</div>`
        : "";

    return `<div role="group">${children || `<div class="file-tree-empty file-tree-empty--message">No matching files</div>`}${truncated}</div>`;
}

function renderItem(
    item: DirectoryTreeItem,
    depth: number,
    matchCache: WeakMap<DirectoryTreeItem, boolean>,
    state: { rendered: number; truncated: boolean },
    options: FileTreeRenderOptions,
): string {
    if (state.truncated) {
        return "";
    }

    if (!matchesQuery(item, matchCache, options.query)) {
        return "";
    }

    if (options.query && item.isDir) {
        return (item.children ?? []).map((child) => renderItem(child, depth, matchCache, state, options)).join("");
    }

    if (options.query && state.rendered >= options.maxSearchResults) {
        state.truncated = true;
        return "";
    }

    const isCollapsed = !options.query && options.collapsedDirectories.has(item.path);
    const children =
        item.isDir && !isCollapsed
            ? (item.children ?? []).map((child) => renderItem(child, depth + 1, matchCache, state, options)).join("")
            : "";
    const expanded = item.isDir ? ` aria-expanded="${!isCollapsed}"` : "";
    const extension = item.name.match(/\.([^.]+)$/)?.[1].toLowerCase() ?? "";
    const fileType = item.isDir ? "Folder"
        : ["md", "markdown", "mdown"].includes(extension) ? "Markdown"
        : extension === "tex" ? "LaTeX"
        : extension === "txt" ? "Text"
        : extension ? extension.toUpperCase() : "File";
    state.rendered += 1;

    return `
        <div class="file-tree-node">
            <button
                class="file-tree-row"
                type="button"
                role="treeitem"
                aria-level="${depth + 1}"
                title="${escapeHtml(item.path)}"
                data-file-tree-path="${escapeHtml(item.path)}"
                data-file-tree-dir="${item.isDir ? "true" : "false"}"
                data-file-tree-selectable="true"
                tabindex="${options.selectedPath === item.path ? "0" : "-1"}"
                style="--file-tree-depth: ${depth}"
                ${options.selectedPath === item.path ? `data-selected="true"` : ""}
                ${expanded}
            >
                <span class="file-tree-chevron" aria-hidden="true"></span>
                <span class="file-tree-name">${escapeHtml(item.name)}</span>
                <span class="file-tree-type" title="${escapeHtml(fileType)}">${escapeHtml(fileType)}</span>
            </button>
            ${children ? `<div class="file-tree-children" role="group" style="--file-tree-depth: ${depth}">${children}</div>` : ""}
        </div>
    `;
}

function matchesQuery(item: DirectoryTreeItem, cache: WeakMap<DirectoryTreeItem, boolean>, query: string): boolean {
    if (!query) {
        return true;
    }

    const cached = cache.get(item);
    if (cached !== undefined) {
        return cached;
    }

    let searchableText = searchableItemText.get(item);
    if (searchableText === undefined) {
        searchableText = `${item.name}\n${item.path}`.toLowerCase();
        searchableItemText.set(item, searchableText);
    }
    const matches =
        searchableText.includes(query) ||
        (item.isDir && Boolean(item.children?.some((child) => matchesQuery(child, cache, query))));

    cache.set(item, matches);
    return matches;
}
