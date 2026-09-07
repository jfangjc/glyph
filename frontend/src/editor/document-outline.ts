import { dispatch, getEditorState } from "./core/store";
import { syncDomSelectionFromState } from "./core/projection";
import { getEditorBlocks } from "./blocks/view";

type OutlineEntry = {
    id: string;
    level: 1 | 2 | 3 | 4 | 5 | 6;
    text: string;
};

let outline: HTMLElement | null = null;
let list: HTMLUListElement | null = null;
let panelList: HTMLUListElement | null = null;
let scrollContainer: HTMLElement | null = null;
let outlineSyncPending = false;
let pendingActiveOutlineFrame = 0;
let activeId: string | null = null;
let renderedEntries: OutlineEntry[] = [];

export function installDocumentOutline(container: HTMLElement): void {
    scrollContainer = container;
    outline = document.createElement("nav");
    outline.className = "document-outline";
    outline.setAttribute("aria-label", "Document outline");

    list = document.createElement("ul");
    list.className = "document-outline-list";
    outline.append(list);
    container.append(outline);

    container.addEventListener("scroll", () => scheduleActiveOutlineItemUpdate(), { passive: true });
    window.addEventListener("resize", () => scheduleActiveOutlineItemUpdate());
    scheduleOutlineSync();
}

/** A second view of the same headings; the side browser stays mounted. */
export function createDocumentOutlinePanel(): HTMLElement {
    const panel = document.createElement("nav");
    panel.className = "document-outline outline-panel";
    panel.setAttribute("aria-label", "Outline headings");
    panelList = document.createElement("ul");
    panelList.className = "document-outline-list";
    panel.append(panelList);
    syncOutlineEntryElements(readOutlineEntries(), panelList);
    applyActiveOutlineId();
    return panel;
}

export function syncDocumentOutlineToBlock(block: HTMLElement | null): void {
    const blocks = getEditorState().blocks.blocks;
    const index = blocks.findIndex(entry => entry.id === block?.dataset.blockId);
    const heading = blocks.slice(0, index + 1).reverse().find(entry => entry.type.startsWith("heading-"));
    setActiveOutlineId(heading?.id ?? null, { scrollActiveItem: false });
}

export function refreshDocumentOutline(): void {
    scheduleOutlineSync();
}

function scheduleOutlineSync(): void {
    if (outlineSyncPending) {
        return;
    }

    outlineSyncPending = true;
    queueMicrotask(() => {
        outlineSyncPending = false;
        syncDocumentOutline();
    });
}

function syncDocumentOutline(): void {
    if (!outline || !list) {
        return;
    }

    const entries = readOutlineEntries();
    const changed = entries.length !== renderedEntries.length || entries.some((entry, index) => {
        const previous = renderedEntries[index];
        return entry.id !== previous.id || entry.level !== previous.level || entry.text !== previous.text;
    });
    if (outline.hidden !== (entries.length === 0)) outline.hidden = entries.length === 0;
    if (changed) {
        renderedEntries = entries;
        syncOutlineEntryElements(entries);
        if (panelList) syncOutlineEntryElements(entries, panelList);
    }

    if (activeId && entries.some((entry) => entry.id === activeId)) {
        if (changed) applyActiveOutlineId();
        return;
    }

    updateActiveOutlineItem({ scrollActiveItem: false });
}

function readOutlineEntries(): OutlineEntry[] {
    const state = getEditorState();
    return state.blocks.blocks
        .map((sourceBlock): OutlineEntry | null => {
            if (!sourceBlock.type.startsWith("heading-")) {
                return null;
            }

            const text = state.doc.slice(sourceBlock.contentFrom, sourceBlock.contentTo).trim();
            if (!text) {
                return null;
            }

            return {
                id: sourceBlock.id,
                level: Number(sourceBlock.type.slice("heading-".length)) as OutlineEntry["level"],
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
        document
            .querySelector<HTMLElement>(`#editor [data-block-id="${CSS.escape(entry.id)}"]`)
            ?.scrollIntoView({ block: "start", behavior: readOutlineScrollBehavior() });
        const state = getEditorState();
        const sourceBlock = state.blocks.blocks.find((block) => block.id === entry.id);
        if (sourceBlock) {
            dispatch({
                changes: [],
                selection: { anchor: sourceBlock.contentFrom, head: sourceBlock.contentFrom },
                annotations: { userEvent: "programmatic", addToHistory: false },
            });
            syncDomSelectionFromState({ focus: "editor" });
            window.dispatchEvent(new Event("glyph:navigation-selected"));
        }
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

function syncOutlineEntryElements(entries: OutlineEntry[], target = list): void {
    if (!target) {
        return;
    }

    const existingItems = Array.from(target.children);
    if (!canUpdateOutlineEntriesInPlace(existingItems, entries)) {
        target.replaceChildren(...entries.map(renderOutlineEntry));
        return;
    }

    for (let index = 0; index < entries.length; index += 1) {
        const item = existingItems[index] as HTMLElement;
        const entry = entries[index];
        const button = item.querySelector<HTMLButtonElement>(".document-outline-button");
        const text = item.querySelector<HTMLElement>(".document-outline-text");

        if (button && button.title !== entry.text) {
            button.title = entry.text;
        }

        if (text && text.textContent !== entry.text) {
            text.textContent = entry.text;
        }
    }
}

function canUpdateOutlineEntriesInPlace(items: Element[], entries: OutlineEntry[]): boolean {
    if (items.length !== entries.length) {
        return false;
    }

    return items.every((item, index) => {
        if (!(item instanceof HTMLElement)) {
            return false;
        }

        const entry = entries[index];
        return item.dataset.outlineId === entry.id && item.dataset.level === String(entry.level);
    });
}

function updateActiveOutlineItem(options: { scrollActiveItem?: boolean } = {}): void {
    if (!list || !scrollContainer) {
        return;
    }

    const headings = getEditorBlocks().filter((block) => {
        return isOutlineHeadingBlock(block);
    });
    const containerRect = scrollContainer.getBoundingClientRect();
    let nextActive = headings[0]?.dataset.blockId ?? null;

    for (const heading of headings) {
        const headingRect = heading.getBoundingClientRect();
        if (isVisibleInContainer(headingRect, containerRect)) {
            nextActive = heading.dataset.blockId ?? nextActive;
            break;
        }

        if (headingRect.top < containerRect.top) {
            nextActive = heading.dataset.blockId ?? nextActive;
        }
    }

    setActiveOutlineId(nextActive, options);
}

function scheduleActiveOutlineItemUpdate(): void {
    if (pendingActiveOutlineFrame) {
        return;
    }

    pendingActiveOutlineFrame = window.requestAnimationFrame(() => {
        pendingActiveOutlineFrame = 0;
        updateActiveOutlineItem();
    });
}

function isVisibleInContainer(elementRect: DOMRect, containerRect: DOMRect): boolean {
    return elementRect.bottom > containerRect.top && elementRect.top < containerRect.bottom;
}

function isOutlineHeadingBlock(block: HTMLElement): boolean {
    const type = block.dataset.type;
    return Boolean(type?.startsWith("heading-") && block.dataset.blockId);
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
    for (const item of [...Array.from(list.children), ...Array.from(panelList?.children ?? [])]) {
        if (item instanceof HTMLElement) {
            const isActive = item.dataset.outlineId === activeId;
            item.dataset.active = isActive ? "true" : "false";
            if (isActive && item.parentElement === list) {
                activeItem = item;
            }
            const button = item.querySelector<HTMLButtonElement>(".document-outline-button");
            if (isActive) {
                button?.setAttribute("aria-current", "location");
            } else {
                button?.removeAttribute("aria-current");
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
            behavior: readOutlineScrollBehavior(),
        });
        return;
    }

    if (itemBottom > viewportBottom) {
        outline.scrollTo({
            top: itemBottom - outline.clientHeight + paddingBottom,
            behavior: readOutlineScrollBehavior(),
        });
    }
}

function readOutlineScrollBehavior(): ScrollBehavior {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}
