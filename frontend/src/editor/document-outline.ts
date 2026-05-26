import { headingTypes, readBlockType } from "./blocks/model";
import { getBlockText, getEditorBlocks } from "./blocks/view";

type OutlineEntry = {
    block: HTMLElement;
    id: string;
    level: 1 | 2;
    text: string;
};

let outline: HTMLElement | null = null;
let list: HTMLUListElement | null = null;
let scrollContainer: HTMLElement | null = null;
let pendingSync = 0;
let activeId: string | null = null;

export function installDocumentOutline(container: HTMLElement, editor: HTMLElement): void {
    scrollContainer = container;
    outline = document.createElement("nav");
    outline.className = "document-outline";
    outline.setAttribute("aria-label", "Document outline");

    list = document.createElement("ul");
    list.className = "document-outline-list";
    outline.append(list);
    container.append(outline);

    const observer = new MutationObserver(scheduleOutlineSync);
    observer.observe(editor, {
        attributes: true,
        attributeFilter: ["data-type"],
        characterData: true,
        childList: true,
        subtree: true,
    });

    container.addEventListener("scroll", () => updateActiveOutlineItem(), { passive: true });
    window.addEventListener("resize", () => updateActiveOutlineItem());
    scheduleOutlineSync();
}

export function syncDocumentOutlineToSelection(): void {
    // The outline is a scroll-position indicator. Selection changes are handled
    // by the active block indicator instead.
}

export function syncDocumentOutlineToBlock(block: HTMLElement | null): void {
    void block;
}

function scheduleOutlineSync(): void {
    if (pendingSync) {
        return;
    }

    pendingSync = window.requestAnimationFrame(() => {
        pendingSync = 0;
        syncDocumentOutline();
    });
}

function syncDocumentOutline(): void {
    if (!outline || !list) {
        return;
    }

    const entries = readOutlineEntries();
    outline.hidden = entries.length === 0;
    list.replaceChildren(...entries.map(renderOutlineEntry));

    if (activeId && entries.some((entry) => entry.id === activeId)) {
        applyActiveOutlineId();
        return;
    }

    updateActiveOutlineItem({ scrollActiveItem: false });
}

function readOutlineEntries(): OutlineEntry[] {
    return getEditorBlocks()
        .map((block, index): OutlineEntry | null => {
            const type = readBlockType(block.dataset.type);
            if (!isOutlineHeadingBlock(block)) {
                return null;
            }

            const text = getBlockText(block).trim();
            const id = block.dataset.outlineId ?? `outline-${Date.now().toString(36)}-${index}`;
            block.dataset.outlineId = id;

            return {
                block,
                id,
                level: type === "heading-1" ? 1 : 2,
                text,
            };
        })
        .filter((entry): entry is OutlineEntry => Boolean(entry));
}

function renderOutlineEntry(entry: OutlineEntry): HTMLLIElement {
    const item = document.createElement("li");
    item.className = "document-outline-item";
    item.dataset.outlineId = entry.id;
    item.dataset.level = String(entry.level);

    const button = document.createElement("button");
    button.className = "document-outline-button";
    button.type = "button";
    button.title = entry.text;
    button.addEventListener("click", () => {
        entry.block.scrollIntoView({ block: "start", behavior: "smooth" });
    });

    const marker = document.createElement("span");
    marker.className = "document-outline-marker";
    marker.setAttribute("aria-hidden", "true");

    const text = document.createElement("span");
    text.className = "document-outline-text";
    text.textContent = entry.text;

    button.append(marker, text);
    item.append(button);
    return item;
}

function updateActiveOutlineItem(options: { scrollActiveItem?: boolean } = {}): void {
    if (!list || !scrollContainer) {
        return;
    }

    const headings = getEditorBlocks().filter((block) => {
        return isOutlineHeadingBlock(block);
    });
    const containerRect = scrollContainer.getBoundingClientRect();
    let nextActive = headings[0]?.dataset.outlineId ?? null;

    for (const heading of headings) {
        const headingRect = heading.getBoundingClientRect();
        if (isVisibleInContainer(headingRect, containerRect)) {
            nextActive = heading.dataset.outlineId ?? nextActive;
            break;
        }

        if (headingRect.top < containerRect.top) {
            nextActive = heading.dataset.outlineId ?? nextActive;
        }
    }

    setActiveOutlineId(nextActive, options);
}

function isVisibleInContainer(elementRect: DOMRect, containerRect: DOMRect): boolean {
    return elementRect.bottom > containerRect.top && elementRect.top < containerRect.bottom;
}

function isOutlineHeadingBlock(block: HTMLElement): boolean {
    const type = readBlockType(block.dataset.type);
    return (type === "heading-1" || type === "heading-2") && headingTypes.has(type) && Boolean(getBlockText(block).trim());
}

function setActiveOutlineId(nextActive: string | null, options: { force?: boolean; scrollActiveItem?: boolean } = {}): void {
    const changed = nextActive !== activeId;
    if (!list || (!changed && !options.force)) {
        return;
    }

    activeId = nextActive;
    const activeItem = applyActiveOutlineId();

    if (options.scrollActiveItem !== false) {
        scrollActiveOutlineItemIntoView(activeItem);
    }
}

function applyActiveOutlineId(): HTMLElement | null {
    if (!list) {
        return null;
    }

    let activeItem: HTMLElement | null = null;
    for (const item of Array.from(list.children)) {
        if (item instanceof HTMLElement) {
            const isActive = item.dataset.outlineId === activeId;
            item.dataset.active = isActive ? "true" : "false";
            if (isActive) {
                activeItem = item;
            }
        }
    }

    return activeItem;
}

function scrollActiveOutlineItemIntoView(activeItem: HTMLElement | null): void {
    if (!outline || !list || !activeItem) {
        return;
    }

    const itemTop = activeItem.offsetTop - list.offsetTop;
    const itemBottom = itemTop + activeItem.offsetHeight;
    const viewportTop = outline.scrollTop;
    const viewportBottom = viewportTop + outline.clientHeight;
    const outlineStyle = window.getComputedStyle(outline);
    const paddingTop = Number.parseFloat(outlineStyle.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(outlineStyle.paddingBottom) || 0;

    if (itemTop < viewportTop) {
        outline.scrollTo({
            top: itemTop - paddingTop,
            behavior: "smooth",
        });
        return;
    }

    if (itemBottom > viewportBottom) {
        outline.scrollTo({
            top: itemBottom - outline.clientHeight + paddingBottom,
            behavior: "smooth",
        });
    }
}
