import editorHtml from "./editor.html?raw";

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

export function installEditor(root: HTMLElement): void {
    root.classList.add("editor-shell");
    root.insertAdjacentHTML("beforeend", editorHtml);

    const editor = getElement<HTMLElement>("editor");

    editor.addEventListener("keydown", handleEditorKeydown);
    editor.addEventListener("input", handleEditorInput);
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
    const blockTemplate = getElement<HTMLTemplateElement>("block-template");
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
