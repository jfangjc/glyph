export function getFileTreeItem(root: HTMLElement, path: string): HTMLButtonElement | null {
    return root.querySelector<HTMLButtonElement>(`[data-file-tree-path="${cssEscape(path)}"]`);
}

export function moveFileTreeSelection(
    root: HTMLElement,
    selectedPath: string | null,
    direction: 1 | -1,
): string | null {
    const items = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-file-tree-selectable="true"]'));
    if (!items.length) {
        return null;
    }

    const currentIndex = selectedPath ? items.findIndex((item) => item.dataset.fileTreePath === selectedPath) : -1;
    const fallbackIndex = direction > 0 ? 0 : items.length - 1;
    const nextIndex = currentIndex >= 0 ? (currentIndex + direction + items.length) % items.length : fallbackIndex;
    const nextPath = items[nextIndex].dataset.fileTreePath ?? null;
    items[nextIndex].scrollIntoView({ block: "nearest" });
    return nextPath;
}

export function syncFileTreeSelection(root: HTMLElement, selectedPath: string | null): string | null {
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

    return hasSelectedPath ? selectedPath : null;
}

function cssEscape(value: string): string {
    return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}
