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

export function syncFileTreeSelectionChange(
    root: HTMLElement,
    selectedPath: string | null,
    previousSelectedPath: string | null,
): string | null {
    if (previousSelectedPath && previousSelectedPath !== selectedPath) {
        setFileTreeItemSelected(getFileTreeItem(root, previousSelectedPath), false);
    }

    const selectedItem = selectedPath ? getFileTreeItem(root, selectedPath) : null;
    if (!selectedItem) {
        return null;
    }

    setFileTreeItemSelected(selectedItem, true);
    return selectedPath;
}

function setFileTreeItemSelected(item: HTMLButtonElement | null, selected: boolean): void {
    if (!item) {
        return;
    }

    if (selected) {
        item.dataset.selected = "true";
        item.classList.add("is-selected");
    } else {
        delete item.dataset.selected;
        item.classList.remove("is-selected");
    }
    item.setAttribute("aria-selected", selected ? "true" : "false");
    item.tabIndex = selected ? 0 : -1;
}

function cssEscape(value: string): string {
    return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}
