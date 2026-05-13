import editorHtml from "./editor.html?raw";

type BlockType =
    | "paragraph"
    | "heading-1"
    | "heading-2"
    | "heading-3"
    | "heading-4"
    | "heading-5"
    | "heading-6"
    | "list"
    | "todo"
    | "quote"
    | "code";

type Shortcut = {
    marker: string;
    type: BlockType;
    indent?: number;
};

type SelectedBlockRange = {
    blocks: HTMLElement[];
    startBlock: HTMLElement;
    endBlock: HTMLElement;
    startOffset: number;
    endOffset: number;
};

const blockLabels: Record<BlockType, string> = {
    paragraph: "Paragraph",
    "heading-1": "Heading 1",
    "heading-2": "Heading 2",
    "heading-3": "Heading 3",
    "heading-4": "Heading 4",
    "heading-5": "Heading 5",
    "heading-6": "Heading 6",
    list: "List item",
    todo: "Todo",
    quote: "Quote",
    code: "Code",
};

const headingTypes = new Set<BlockType>([
    "heading-1",
    "heading-2",
    "heading-3",
    "heading-4",
    "heading-5",
    "heading-6",
]);

const shortcuts: Shortcut[] = [
    { marker: "###### ", type: "heading-6" },
    { marker: "##### ", type: "heading-5" },
    { marker: "#### ", type: "heading-4" },
    { marker: "### ", type: "heading-3" },
    { marker: "# ", type: "heading-1" },
    { marker: "## ", type: "heading-2" },
    { marker: "    - ", type: "list", indent: 2 },
    { marker: "  - ", type: "list", indent: 1 },
    { marker: "- [ ] ", type: "todo" },
    { marker: "- ", type: "list" },
    { marker: "> ", type: "quote" },
    { marker: "[ ] ", type: "todo" },
    { marker: "```", type: "code" },
];

const htmlEscapes: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};

export function installEditor(root: HTMLElement): void {
    root.classList.add("editor-shell");
    root.insertAdjacentHTML("beforeend", editorHtml);

    const editor = getElement<HTMLElement>("editor");

    editor.addEventListener("keydown", handleEditorKeydown);
    editor.addEventListener("input", handleEditorInput);
    editor.addEventListener("paste", handleEditorPaste);
}

function handleEditorKeydown(event: KeyboardEvent): void {
    const editor = getElement<HTMLElement>("editor");

    if (isSelectAllShortcut(event)) {
        event.preventDefault();
        selectEditorContents(editor);
        return;
    }

    const block = getActiveBlock(event.target);
    if (!block) {
        return;
    }

    if (event.key === "Tab" && indentListBlocks(block, event.shiftKey ? -1 : 1)) {
        event.preventDefault();
        return;
    }

    if (event.key === "Enter") {
        event.preventDefault();
        if (readBlockType(block.dataset.type) === "code" && !event.ctrlKey && !event.metaKey) {
            replaceSelectionWithText(block, "\n");
            return;
        }

        splitBlock(deleteSelectedContent() ?? block);
        return;
    }

    if (event.key === "Backspace" || event.key === "Delete") {
        if (deleteSelectedContent()) {
            event.preventDefault();
            return;
        }

        if (event.key === "Backspace" && removeOrMergeBackward(block)) {
            event.preventDefault();
            return;
        }

        if (event.key === "Delete" && mergeForward(block)) {
            event.preventDefault();
            return;
        }
    }

    if (isPlainTextKey(event) && getSelectedBlockRange()) {
        event.preventDefault();
        replaceSelectionWithText(block, event.key);
    }
}

function handleEditorInput(event: Event): void {
    const block = getActiveBlock(event.target);
    if (!block) {
        return;
    }

    if (!applyMarkdownShortcut(block)) {
        renderBlockContent(block);
    }
}

function handleEditorPaste(event: ClipboardEvent): void {
    const text = event.clipboardData?.getData("text/plain");
    const block = getActiveBlock(event.target);

    if (!text || !block) {
        return;
    }

    event.preventDefault();
    insertPastedText(block, text.replace(/\r\n?/g, "\n"));
}

function splitBlock(block: HTMLElement): void {
    const content = getBlockContent(block);
    const selection = document.getSelection();
    const text = getBlockText(block);
    const offset = selection?.focusNode
        ? getCaretOffset(content, selection.focusNode, selection.focusOffset)
        : text.length;
    const currentType = readBlockType(block.dataset.type);

    if (text === "" && shouldResetEmptyBlock(currentType)) {
        setBlockType(block, "paragraph");
        focusBlock(block);
        return;
    }

    const before = text.slice(0, offset);
    const after = text.slice(offset);
    const nextType = headingTypes.has(currentType) || currentType === "code" ? "paragraph" : currentType;
    const nextBlock = createBlock(nextType, after);

    setBlockText(block, before);
    block.after(nextBlock);
    setBlockIndent(nextBlock, nextType === "list" ? readBlockIndent(block) : 0);
    focusBlockAtOffset(nextBlock, 0);
}

function applyMarkdownShortcut(block: HTMLElement): boolean {
    const text = getBlockText(block);
    const shortcut = shortcuts.find((candidate) => text.startsWith(candidate.marker));

    if (!shortcut) {
        return false;
    }

    setBlockType(block, shortcut.type);
    setBlockIndent(block, shortcut.indent ?? 0);
    setBlockText(block, text.slice(shortcut.marker.length));
    focusBlock(block);
    return true;
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

    if (type !== "list") {
        setBlockIndent(block, 0);
    }
}

function setBlockText(block: HTMLElement, text: string): void {
    const content = getBlockContent(block);

    if (readBlockType(block.dataset.type) === "code") {
        content.textContent = text;
        return;
    }

    content.innerHTML = renderInlineCode(text);
}

function setBlockIndent(block: HTMLElement, indent: number): void {
    if (indent > 0) {
        block.dataset.indent = String(Math.min(indent, 3));
        return;
    }

    delete block.dataset.indent;
}

function getBlockText(block: HTMLElement): string {
    return getBlockContent(block).textContent ?? "";
}

function readBlockIndent(block: HTMLElement): number {
    const indent = Number(block.dataset.indent ?? 0);
    return Number.isFinite(indent) ? indent : 0;
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
    focusBlockAtOffset(block, getBlockText(block).length);
}

function focusBlockAtOffset(block: HTMLElement, offset: number): void {
    const editor = getElement<HTMLElement>("editor");
    const content = getBlockContent(block);
    const selection = document.getSelection();
    const range = document.createRange();
    const position = getTextPosition(content, offset);

    editor.focus();

    range.setStart(position.node, position.offset);
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

function getCurrentBlockOffset(block: HTMLElement): number {
    const content = getBlockContent(block);
    const selection = document.getSelection();

    if (selection?.focusNode && (selection.focusNode === content || content.contains(selection.focusNode))) {
        return getCaretOffset(content, selection.focusNode, selection.focusOffset);
    }

    return getBlockText(block).length;
}

function getTextPosition(root: HTMLElement, offset: number): { node: Node; offset: number } {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    let remaining = Math.max(0, offset);

    while (current) {
        const length = current.textContent?.length ?? 0;
        if (remaining <= length) {
            return { node: current, offset: remaining };
        }

        remaining -= length;
        current = walker.nextNode();
    }

    return { node: root, offset: root.childNodes.length };
}

function getActiveBlock(target: EventTarget | Node | null): HTMLElement | null {
    return findBlock(target) ?? findBlock(document.getSelection()?.focusNode ?? null);
}

function getEditorBlocks(): HTMLElement[] {
    const editor = getElement<HTMLElement>("editor");
    return Array.from(editor.querySelectorAll<HTMLElement>("[data-block]"));
}

function getSelectedBlockRange(): SelectedBlockRange | null {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return null;
    }

    const range = selection.getRangeAt(0);
    const startBlock = findBlockFromBoundary(range.startContainer, range.startOffset, "start");
    const endBlock = findBlockFromBoundary(range.endContainer, range.endOffset, "end");
    const allBlocks = getEditorBlocks();
    const startIndex = startBlock ? allBlocks.indexOf(startBlock) : -1;
    const endIndex = endBlock ? allBlocks.indexOf(endBlock) : -1;

    if (!startBlock || !endBlock || startIndex < 0 || endIndex < 0) {
        return null;
    }

    return {
        blocks: allBlocks.slice(startIndex, endIndex + 1),
        startBlock,
        endBlock,
        startOffset: getBoundaryOffset(startBlock, range.startContainer, range.startOffset, "start"),
        endOffset: getBoundaryOffset(endBlock, range.endContainer, range.endOffset, "end"),
    };
}

function findBlockFromBoundary(container: Node, offset: number, edge: "start" | "end"): HTMLElement | null {
    const directBlock = findBlock(container);
    if (directBlock) {
        return directBlock;
    }

    if (!(container instanceof HTMLElement) || container.id !== "editor") {
        return null;
    }

    const blocks = getEditorBlocks();
    if (edge === "start") {
        return blocks[offset] ?? blocks[blocks.length - 1] ?? null;
    }

    return blocks[offset - 1] ?? blocks[0] ?? null;
}

function getBoundaryOffset(
    block: HTMLElement,
    container: Node,
    offset: number,
    edge: "start" | "end",
): number {
    const content = getBlockContent(block);
    if (container === content || content.contains(container)) {
        return getCaretOffset(content, container, offset);
    }

    return edge === "start" ? 0 : getBlockText(block).length;
}

function deleteSelectedContent(): HTMLElement | null {
    const selectedRange = getSelectedBlockRange();
    if (!selectedRange) {
        return null;
    }

    const { blocks, startBlock, endBlock, startOffset, endOffset } = selectedRange;
    const startText = getBlockText(startBlock);
    const endText = getBlockText(endBlock);

    if (startBlock === endBlock) {
        setBlockText(startBlock, startText.slice(0, startOffset) + startText.slice(endOffset));
        focusBlockAtOffset(startBlock, startOffset);
        return startBlock;
    }

    setBlockText(startBlock, startText.slice(0, startOffset) + endText.slice(endOffset));

    for (const block of blocks.slice(1)) {
        block.remove();
    }

    if (getBlockText(startBlock) === "") {
        setBlockType(startBlock, "paragraph");
    }

    focusBlockAtOffset(startBlock, startOffset);
    return startBlock;
}

function replaceSelectionWithText(block: HTMLElement, text: string): void {
    const selectedBlock = deleteSelectedContent() ?? block;
    insertTextAtCaret(selectedBlock, text);
}

function insertTextAtCaret(block: HTMLElement, text: string): void {
    const content = getBlockContent(block);
    const selection = document.getSelection();
    const selectedText = getBlockText(block);
    const offset = selection?.focusNode
        ? getCaretOffset(content, selection.focusNode, selection.focusOffset)
        : selectedText.length;

    setBlockText(block, selectedText.slice(0, offset) + text + selectedText.slice(offset));
    focusBlockAtOffset(block, offset + text.length);
}

function insertPastedText(block: HTMLElement, text: string): void {
    const selectedBlock = deleteSelectedContent() ?? block;
    const lines = text.split("\n");

    if (readBlockType(selectedBlock.dataset.type) === "code" || lines.length === 1) {
        insertTextAtCaret(selectedBlock, text);
        return;
    }

    const content = getBlockContent(selectedBlock);
    const selection = document.getSelection();
    const currentText = getBlockText(selectedBlock);
    const offset = selection?.focusNode
        ? getCaretOffset(content, selection.focusNode, selection.focusOffset)
        : currentText.length;
    const before = currentText.slice(0, offset);
    const after = currentText.slice(offset);
    let currentBlock = selectedBlock;

    setBlockText(selectedBlock, before + lines[0]);

    for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        const isLastLine = lineIndex === lines.length - 1;
        const nextBlock = createBlock("paragraph", isLastLine ? line + after : line);

        currentBlock.after(nextBlock);
        currentBlock = nextBlock;
    }

    focusBlockAtOffset(currentBlock, lines[lines.length - 1].length);
}

function indentListBlocks(block: HTMLElement, delta: number): boolean {
    const selectedRange = getSelectedBlockRange();
    const blocks = selectedRange?.blocks ?? [block];
    const listBlocks = blocks.filter((candidate) => readBlockType(candidate.dataset.type) === "list");

    if (listBlocks.length === 0) {
        return false;
    }

    for (const listBlock of listBlocks) {
        setBlockIndent(listBlock, readBlockIndent(listBlock) + delta);
    }

    focusBlockAtOffset(block, getCurrentBlockOffset(block));
    return true;
}

function removeOrMergeBackward(block: HTMLElement): boolean {
    const type = readBlockType(block.dataset.type);

    if (getBlockText(block) === "") {
        const previous = getSiblingBlock(block, "previous");
        if (previous) {
            block.remove();
            focusBlock(previous);
            return true;
        }

        if (type !== "paragraph") {
            setBlockType(block, "paragraph");
            focusBlock(block);
            return true;
        }

        return true;
    }

    if (!isCaretAtBlockEdge(block, "start")) {
        return false;
    }

    const previous = getSiblingBlock(block, "previous");
    if (!previous) {
        return true;
    }

    const offset = getBlockText(previous).length;
    setBlockText(previous, getBlockText(previous) + getBlockText(block));
    block.remove();
    focusBlockAtOffset(previous, offset);
    return true;
}

function mergeForward(block: HTMLElement): boolean {
    if (!isCaretAtBlockEdge(block, "end")) {
        return false;
    }

    const next = getSiblingBlock(block, "next");
    if (!next) {
        return true;
    }

    const offset = getBlockText(block).length;
    setBlockText(block, getBlockText(block) + getBlockText(next));
    next.remove();
    focusBlockAtOffset(block, offset);
    return true;
}

function getSiblingBlock(block: HTMLElement, direction: "previous" | "next"): HTMLElement | null {
    const sibling = direction === "previous" ? block.previousElementSibling : block.nextElementSibling;
    return sibling instanceof HTMLElement && sibling.matches("[data-block]") ? sibling : null;
}

function isCaretAtBlockEdge(block: HTMLElement, edge: "start" | "end"): boolean {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed || !selection.focusNode) {
        return false;
    }

    const content = getBlockContent(block);
    if (selection.focusNode !== content && !content.contains(selection.focusNode)) {
        return false;
    }

    const offset = getCaretOffset(content, selection.focusNode, selection.focusOffset);
    return edge === "start" ? offset === 0 : offset === getBlockText(block).length;
}

function selectEditorContents(editor: HTMLElement): void {
    const blocks = getEditorBlocks();
    const firstBlock = blocks[0];
    const lastBlock = blocks[blocks.length - 1];

    if (!firstBlock || !lastBlock) {
        return;
    }

    const firstContent = getBlockContent(firstBlock);
    const lastContent = getBlockContent(lastBlock);
    const selection = document.getSelection();
    const range = document.createRange();

    editor.focus();
    range.setStart(firstContent, 0);
    range.setEnd(lastContent, lastContent.childNodes.length);
    selection?.removeAllRanges();
    selection?.addRange(range);
}

function renderBlockContent(block: HTMLElement): void {
    if (readBlockType(block.dataset.type) === "code") {
        return;
    }

    const content = getBlockContent(block);
    const selection = document.getSelection();
    const offset =
        selection?.focusNode && (selection.focusNode === content || content.contains(selection.focusNode))
            ? getCaretOffset(content, selection.focusNode, selection.focusOffset)
            : getBlockText(block).length;
    const text = getBlockText(block);
    const html = renderInlineCode(text);

    if (content.innerHTML === html) {
        return;
    }

    content.innerHTML = html;
    focusBlockAtOffset(block, offset);
}

function renderInlineCode(text: string): string {
    let html = "";
    let index = 0;

    while (index < text.length) {
        const start = text.indexOf("`", index);
        if (start < 0) {
            html += escapeHtml(text.slice(index));
            break;
        }

        const end = text.indexOf("`", start + 1);
        if (end < 0) {
            html += escapeHtml(text.slice(index));
            break;
        }

        html += escapeHtml(text.slice(index, start));
        html += `<code>${escapeHtml(text.slice(start, end + 1))}</code>`;
        index = end + 1;
    }

    return html;
}

function shouldResetEmptyBlock(type: BlockType): boolean {
    return type === "list" || type === "todo" || type === "quote";
}

function isSelectAllShortcut(event: KeyboardEvent): boolean {
    return event.key.toLowerCase() === "a" && (event.ctrlKey || event.metaKey);
}

function isPlainTextKey(event: KeyboardEvent): boolean {
    return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (character) => htmlEscapes[character]);
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
