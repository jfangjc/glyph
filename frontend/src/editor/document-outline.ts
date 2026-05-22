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

    container.addEventListener("scroll", updateActiveOutlineItem, { passive: true });
    window.addEventListener("resize", updateActiveOutlineItem);
    scheduleOutlineSync();
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
    updateActiveOutlineItem();
}

function readOutlineEntries(): OutlineEntry[] {
    return getEditorBlocks()
        .map((block, index): OutlineEntry | null => {
            const type = readBlockType(block.dataset.type);
            if (!headingTypes.has(type) || (type !== "heading-1" && type !== "heading-2")) {
                return null;
            }

            const text = getBlockText(block).trim();
            if (!text) {
                return null;
            }

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

function updateActiveOutlineItem(): void {
    if (!list || !scrollContainer) {
        return;
    }

    const headings = getEditorBlocks().filter((block) => {
        const type = readBlockType(block.dataset.type);
        return type === "heading-1" || type === "heading-2";
    });
    const containerTop = scrollContainer.getBoundingClientRect().top;
    const activationLine = containerTop + 96;
    let nextActive = headings[0]?.dataset.outlineId ?? null;

    for (const heading of headings) {
        if (heading.getBoundingClientRect().top <= activationLine) {
            nextActive = heading.dataset.outlineId ?? nextActive;
        } else {
            break;
        }
    }

    if (nextActive === activeId) {
        return;
    }

    activeId = nextActive;
    for (const item of Array.from(list.children)) {
        if (item instanceof HTMLElement) {
            item.dataset.active = item.dataset.outlineId === activeId ? "true" : "false";
        }
    }
}
