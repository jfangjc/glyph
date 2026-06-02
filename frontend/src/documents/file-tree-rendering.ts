import type { DirectoryTree, DirectoryTreeItem } from "../bridge/types";
import { escapeHtml } from "../utils/text";

type FileTreeRenderOptions = {
    tree: DirectoryTree | null;
    query: string;
    selectedPath: string | null;
    collapsedDirectories: Set<string>;
    maxSearchResults: number;
};

export function renderFileTreeHtml(options: FileTreeRenderOptions): string {
    if (!options.tree) {
        return `<div class="file-tree-empty">Open a directory with Ctrl+Shift+O</div>`;
    }

    const state = { rendered: 0, truncated: false };
    const matchCache = new WeakMap<DirectoryTreeItem, boolean>();
    const children = options.tree.children
        .map((child) => renderItem(child, 0, matchCache, state, options))
        .join("");
    const truncated = state.truncated ? `<div class="file-tree-empty">Keep typing to narrow results</div>` : "";

    return `<div role="group">${children || `<div class="file-tree-empty">No matching files</div>`}${truncated}</div>`;
}

function renderItem(
    item: DirectoryTreeItem,
    depth: number,
    matchCache: WeakMap<DirectoryTreeItem, boolean>,
    state: { rendered: number; truncated: boolean },
    options: FileTreeRenderOptions,
): string {
    if (!matchesQuery(item, matchCache, options.query)) {
        return "";
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
                ${options.selectedPath === item.path ? `data-selected="true"` : ""}
                ${expanded}
            >
                <span class="file-tree-disclosure">${disclosure}</span>
                <span class="file-tree-name">${escapeHtml(item.name)}</span>
            </button>
            ${children ? `<div role="group">${children}</div>` : ""}
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

    const matches =
        item.name.toLowerCase().includes(query) ||
        item.path.toLowerCase().includes(query) ||
        (item.isDir && Boolean(item.children?.some((child) => matchesQuery(child, cache, query))));

    cache.set(item, matches);
    return matches;
}
