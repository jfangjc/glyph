import "./styles.css";
import "./window-controls.css";
import windowControlsHtml from "./window-controls.html?raw";
import { System, Window } from "@wailsio/runtime";

type BlockType = "paragraph" | "heading-1" | "heading-2" | "list" | "todo" | "quote" | "code";

type Shortcut = {
    marker: string;
    type: BlockType;
};

const blockLabels: Record<BlockType, string> = {
    paragraph: "Paragraph",
    "heading-1": "Heading 1",
    "heading-2": "Heading 2",
    list: "List item",
    todo: "Todo",
    quote: "Quote",
    code: "Code",
};

const shortcuts: Shortcut[] = [
    { marker: "# ", type: "heading-1" },
    { marker: "## ", type: "heading-2" },
    { marker: "- ", type: "list" },
    { marker: "> ", type: "quote" },
    { marker: "[ ] ", type: "todo" },
    { marker: "```", type: "code" },
];

const editor = getElement<HTMLElement>("editor");
const blockTemplate = getElement<HTMLTemplateElement>("block-template");
let maximiseButton: HTMLButtonElement | null = null;
let snapAssistTimer = 0;

installWindowControls();

editor.addEventListener("keydown", handleEditorKeydown);
editor.addEventListener("input", handleEditorInput);

function installWindowControls(): void {
    if (!isWindowsHost()) {
        return;
    }

    document.body.insertAdjacentHTML("afterbegin", windowControlsHtml);

    const titlebar = getElement<HTMLElement>("windows-titlebar");
    titlebar.hidden = false;
    titlebar.addEventListener("click", handleWindowControlClick);

    maximiseButton = getElement<HTMLButtonElement>("windows-maximise-button");
    maximiseButton.addEventListener("pointerenter", scheduleSnapAssist);
    maximiseButton.addEventListener("pointerleave", cancelSnapAssist);
    maximiseButton.addEventListener("pointerdown", cancelSnapAssist);
    document.body.classList.add("window-focused");
    window.addEventListener("focus", () => document.body.classList.add("window-focused"));
    window.addEventListener("blur", () => document.body.classList.remove("window-focused"));
    window.addEventListener("resize", () => void syncMaximiseButton());
    void syncMaximiseButton();
}

function isWindowsHost(): boolean {
    return System.IsWindows() || navigator.userAgent.includes("Windows") || navigator.platform.startsWith("Win");
}

function handleWindowControlClick(event: MouseEvent): void {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>("[data-window-action]");
    const action = button?.dataset.windowAction;

    if (!action) {
        return;
    }

    if (action === "minimise") {
        void Window.Minimise();
        return;
    }

    if (action === "maximise") {
        cancelSnapAssist();
        void Window.ToggleMaximise().then(syncMaximiseButton);
        return;
    }

    if (action === "close") {
        void Window.Close();
    }
}

function scheduleSnapAssist(): void {
    if (!System.IsWindows() || snapAssistTimer) {
        return;
    }

    snapAssistTimer = window.setTimeout(() => {
        snapAssistTimer = 0;
        void Window.SnapAssist();
    }, 500);
}

function cancelSnapAssist(): void {
    if (!snapAssistTimer) {
        return;
    }

    window.clearTimeout(snapAssistTimer);
    snapAssistTimer = 0;
}

async function syncMaximiseButton(): Promise<void> {
    if (!maximiseButton || !System.IsWindows()) {
        return;
    }

    const isMaximised = await Window.IsMaximised();
    const icon = maximiseButton.querySelector<HTMLElement>(".window-control-icon");

    maximiseButton.setAttribute("aria-label", isMaximised ? "Restore" : "Maximize");
    if (icon) {
        icon.innerHTML = isMaximised ? "&#xE923;" : "&#xE922;";
    }
}

function handleEditorKeydown(event: KeyboardEvent): void {
    const block = findBlock(event.target);
    if (!block) {
        return;
    }

    if (event.key === "Enter") {
        event.preventDefault();
        splitBlock(block);
        return;
    }

    if (event.key === "Backspace" && getBlockText(block) === "") {
        const previous = block.previousElementSibling;
        if (previous instanceof HTMLElement && previous.matches("[data-block]")) {
            event.preventDefault();
            block.remove();
            focusBlock(previous);
        }
    }
}

function handleEditorInput(event: Event): void {
    const block = findBlock(event.target);
    if (!block) {
        return;
    }

    applyMarkdownShortcut(block);
}

function splitBlock(block: HTMLElement): void {
    const content = getBlockContent(block);
    const selection = document.getSelection();
    const text = getBlockText(block);
    const offset = selection?.anchorNode
        ? getCaretOffset(content, selection.anchorNode, selection.anchorOffset)
        : text.length;
    const before = text.slice(0, offset);
    const after = text.slice(offset);
    const nextType =
        block.dataset.type === "heading-1" || block.dataset.type === "heading-2"
            ? "paragraph"
            : readBlockType(block.dataset.type);
    const nextBlock = createBlock(nextType, after);

    setBlockText(block, before);
    block.after(nextBlock);
    focusBlock(nextBlock);
}

function applyMarkdownShortcut(block: HTMLElement): void {
    const text = getBlockText(block);
    const shortcut = shortcuts.find((candidate) => text.startsWith(candidate.marker));

    if (!shortcut) {
        return;
    }

    setBlockType(block, shortcut.type);
    setBlockText(block, text.slice(shortcut.marker.length));
    focusBlock(block);
}

function createBlock(type: BlockType = "paragraph", text = ""): HTMLElement {
    const fragment = blockTemplate.content.cloneNode(true) as DocumentFragment;
    const block = fragment.querySelector<HTMLElement>("[data-block]");

    if (!block) {
        throw new Error("Block template is missing [data-block]");
    }

    setBlockType(block, type);
    setBlockText(block, text);
    return block;
}

function setBlockType(block: HTMLElement, type: BlockType): void {
    block.dataset.type = type;
    getBlockContent(block).setAttribute("aria-label", `${blockLabels[type]} block`);
}

function setBlockText(block: HTMLElement, text: string): void {
    getBlockContent(block).textContent = text;
}

function getBlockText(block: HTMLElement): string {
    return getBlockContent(block).textContent ?? "";
}

function getBlockContent(block: HTMLElement): HTMLElement {
    const content = block.querySelector<HTMLElement>(".block-content");
    if (!content) {
        throw new Error("Block is missing .block-content");
    }
    return content;
}

function findBlock(target: EventTarget | Node | null): HTMLElement | null {
    if (!(target instanceof Node)) {
        return null;
    }

    const element = target instanceof Element ? target : target.parentElement;
    return element?.closest("[data-block]") as HTMLElement | null;
}

function focusBlock(block: HTMLElement): void {
    const content = getBlockContent(block);
    const selection = document.getSelection();
    const range = document.createRange();
    const textNode = content.firstChild;
    const offset = content.textContent?.length ?? 0;

    content.focus();

    if (textNode && textNode.nodeType === Node.TEXT_NODE) {
        range.setStart(textNode, offset);
    } else {
        range.setStart(content, 0);
    }

    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
}

function getCaretOffset(root: HTMLElement, anchorNode: Node, anchorOffset: number): number {
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(anchorNode, anchorOffset);
    return range.toString().length;
}

function readBlockType(value: string | undefined): BlockType {
    if (value && value in blockLabels) {
        return value as BlockType;
    }

    return "paragraph";
}

function getElement<TElement extends HTMLElement>(id: string): TElement {
    const element = document.getElementById(id);
    if (!element) {
        throw new Error(`Missing element: ${id}`);
    }
    return element as TElement;
}
