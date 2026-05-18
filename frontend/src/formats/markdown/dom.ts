export type MarkdownTokenEdge = "start" | "end";

const caretSpacerCharacter = String.fromCharCode(8203);

export function getMarkdownText(node: Node): string {
    if (shouldIgnoreMarkdownNode(node)) {
        return "";
    }

    const renderedMarkdown = readRenderedMarkdown(node);
    if (renderedMarkdown !== null) {
        return renderedMarkdown;
    }

    if (node.nodeType === Node.TEXT_NODE) {
        return stripCaretSpacers(node.textContent ?? "");
    }

    return getMarkdownChildText(node);
}

export function getMarkdownBoundaryOffset(current: Node, anchorNode: Node, anchorOffset: number): number {
    if (shouldIgnoreMarkdownNode(current)) {
        return 0;
    }

    const renderedMarkdown = readRenderedMarkdown(current);
    if (renderedMarkdown !== null) {
        return current === anchorNode && anchorOffset <= 0 ? 0 : renderedMarkdown.length;
    }

    if (current === anchorNode) {
        if (current.nodeType === Node.TEXT_NODE) {
            return stripCaretSpacers((current.textContent ?? "").slice(0, anchorOffset)).length;
        }

        return getMarkdownLengthBeforeChild(current, anchorOffset);
    }

    let offset = 0;
    for (const child of Array.from(current.childNodes)) {
        if (child === anchorNode || child.contains(anchorNode)) {
            return offset + getMarkdownBoundaryOffset(child, anchorNode, anchorOffset);
        }

        offset += getMarkdownText(child).length;
    }

    return offset;
}

export function getMarkdownLengthBeforeChild(node: Node, childOffset: number): number {
    return Array.from(node.childNodes)
        .slice(0, Math.max(0, childOffset))
        .reduce((length, child) => length + getMarkdownText(child).length, 0);
}

export function findMarkdownTextPosition(root: HTMLElement, offset: number): { node: Node; offset: number } | null {
    const remaining = { value: offset };

    for (const child of Array.from(root.childNodes)) {
        const position = findMarkdownTextPositionInNode(child, remaining);
        if (position) {
            return position;
        }
    }

    return null;
}

export function findAdjacentInactiveMarkdownToken(
    node: Node,
    offset: number,
    direction: "previous" | "next",
): HTMLElement | null {
    const boundary = getSelectionBoundary(node, offset, direction);
    if (!boundary) {
        return null;
    }

    let candidate: Node | null =
        direction === "previous"
            ? boundary.parent.childNodes[boundary.offset - 1] ?? null
            : boundary.parent.childNodes[boundary.offset] ?? null;

    while (candidate?.nodeType === Node.TEXT_NODE && isCaretSpacerOnly(candidate.textContent ?? "")) {
        candidate = direction === "previous" ? candidate.previousSibling : candidate.nextSibling;
    }

    if (candidate instanceof HTMLElement && candidate.classList.contains("markdown-token") && candidate.dataset.active !== "true") {
        return candidate;
    }

    return null;
}

export function findMarkdownTokenAtCaret(
    node: Node,
    offset: number,
    isTokenMatch: (token: HTMLElement) => boolean = () => true,
): { token: HTMLElement; edge: MarkdownTokenEdge } | null {
    const containingToken = findContainingInactiveMarkdownToken(node);
    if (containingToken && isTokenMatch(containingToken)) {
        return { token: containingToken, edge: offset <= 0 ? "start" : "end" };
    }

    const previousToken = findAdjacentInactiveMarkdownToken(node, offset, "previous");
    if (previousToken && isTokenMatch(previousToken)) {
        return { token: previousToken, edge: "end" };
    }

    const nextToken = findAdjacentInactiveMarkdownToken(node, offset, "next");
    if (nextToken && isTokenMatch(nextToken)) {
        return { token: nextToken, edge: "start" };
    }

    return null;
}

function findMarkdownTextPositionInNode(
    node: Node,
    remaining: { value: number },
): { node: Node; offset: number } | null {
    if (shouldIgnoreMarkdownNode(node)) {
        return null;
    }

    const renderedMarkdown = readRenderedMarkdown(node);
    if (renderedMarkdown !== null) {
        if (remaining.value <= renderedMarkdown.length) {
            return getAtomicNodePosition(node, remaining.value >= renderedMarkdown.length);
        }

        remaining.value -= renderedMarkdown.length;
        return null;
    }

    if (isInactiveMarkdownToken(node)) {
        const length = getMarkdownText(node).length;
        if (remaining.value <= length) {
            return getAtomicNodePosition(node, remaining.value >= length);
        }

        remaining.value -= length;
        return null;
    }

    if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? "";
        const length = stripCaretSpacers(text).length;
        if (remaining.value <= length) {
            return { node, offset: getDomTextOffsetForMarkdownOffset(text, remaining.value) };
        }

        remaining.value -= length;
        return null;
    }

    for (const child of Array.from(node.childNodes)) {
        const position = findMarkdownTextPositionInNode(child, remaining);
        if (position) {
            return position;
        }
    }

    return null;
}

function getMarkdownChildText(node: Node): string {
    let text = "";
    for (const child of Array.from(node.childNodes)) {
        text += getMarkdownText(child);
    }

    return text;
}

function getAtomicNodePosition(node: Node, after: boolean): { node: Node; offset: number } {
    const parent = node.parentNode;
    if (!parent) {
        return { node, offset: 0 };
    }

    const childIndex = Array.from(parent.childNodes).findIndex((child) => child === node);
    return { node: parent, offset: Math.max(0, childIndex) + (after ? 1 : 0) };
}

function findContainingInactiveMarkdownToken(node: Node): HTMLElement | null {
    const element = node instanceof Element ? node : node.parentElement;
    const token = element?.closest<HTMLElement>(".markdown-token");

    return token && token.dataset.active !== "true" ? token : null;
}

function getSelectionBoundary(
    node: Node,
    offset: number,
    direction: "previous" | "next",
): { parent: Node; offset: number } | null {
    if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? "";
        const before = stripCaretSpacers(text.slice(0, offset));
        const after = stripCaretSpacers(text.slice(offset));

        if ((direction === "previous" && before !== "") || (direction === "next" && after !== "")) {
            return null;
        }

        const parent = node.parentNode;
        if (!parent) {
            return null;
        }

        const childIndex = Array.from(parent.childNodes).findIndex((child) => child === node);
        return { parent, offset: direction === "previous" ? childIndex : childIndex + 1 };
    }

    return { parent: node, offset };
}

function isCaretSpacerOnly(text: string): boolean {
    return text !== "" && stripCaretSpacers(text) === "";
}

function stripCaretSpacers(text: string): string {
    return text.split(caretSpacerCharacter).join("");
}

function getDomTextOffsetForMarkdownOffset(text: string, offset: number): number {
    let markdownOffset = 0;

    for (let index = 0; index < text.length; index += 1) {
        if (text[index] === caretSpacerCharacter) {
            continue;
        }

        if (markdownOffset >= offset) {
            return index;
        }

        markdownOffset += 1;
    }

    return text.length;
}

function readRenderedMarkdown(node: Node): string | null {
    if (!(node instanceof HTMLElement)) {
        return null;
    }

    return node.dataset.markdownRaw ?? null;
}

function shouldIgnoreMarkdownNode(node: Node): boolean {
    return node instanceof HTMLElement && node.dataset.markdownIgnore === "true";
}

function isInactiveMarkdownToken(node: Node): boolean {
    return node instanceof HTMLElement && node.classList.contains("markdown-token") && node.dataset.active !== "true";
}
