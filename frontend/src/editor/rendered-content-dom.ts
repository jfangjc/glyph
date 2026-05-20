export type RenderedContentTokenEdge = "start" | "end";

export const caretSpacerCharacter = String.fromCharCode(8203);

export function getRenderedContentText(node: Node): string {
    if (shouldIgnoreRenderedContentNode(node)) {
        return "";
    }

    const renderedText = readRenderedContentRawText(node);
    if (renderedText !== null) {
        return renderedText;
    }

    if (node.nodeType === Node.TEXT_NODE) {
        return stripCaretSpacers(node.textContent ?? "");
    }

    return getRenderedContentChildText(node);
}

export function getRenderedContentBoundaryOffset(current: Node, anchorNode: Node, anchorOffset: number): number {
    if (shouldIgnoreRenderedContentNode(current)) {
        return 0;
    }

    const renderedText = readRenderedContentRawText(current);
    if (renderedText !== null) {
        return current === anchorNode && anchorOffset <= 0 ? 0 : renderedText.length;
    }

    if (current === anchorNode) {
        if (current.nodeType === Node.TEXT_NODE) {
            return stripCaretSpacers((current.textContent ?? "").slice(0, anchorOffset)).length;
        }

        return getRenderedContentLengthBeforeChild(current, anchorOffset);
    }

    let offset = 0;
    for (const child of Array.from(current.childNodes)) {
        if (child === anchorNode || child.contains(anchorNode)) {
            return offset + getRenderedContentBoundaryOffset(child, anchorNode, anchorOffset);
        }

        offset += getRenderedContentText(child).length;
    }

    return offset;
}

export function getRenderedContentLengthBeforeChild(node: Node, childOffset: number): number {
    return Array.from(node.childNodes)
        .slice(0, Math.max(0, childOffset))
        .reduce((length, child) => length + getRenderedContentText(child).length, 0);
}

export function findRenderedContentTextPosition(root: HTMLElement, offset: number): { node: Node; offset: number } | null {
    const remaining = { value: offset };

    for (const child of Array.from(root.childNodes)) {
        const position = findRenderedContentTextPositionInNode(child, remaining);
        if (position) {
            return position;
        }
    }

    return null;
}

export function stripCaretSpacers(text: string): string {
    return text.split(caretSpacerCharacter).join("");
}

function findRenderedContentTextPositionInNode(
    node: Node,
    remaining: { value: number },
): { node: Node; offset: number } | null {
    if (shouldIgnoreRenderedContentNode(node)) {
        return null;
    }

    const renderedText = readRenderedContentRawText(node);
    if (renderedText !== null) {
        if (remaining.value <= renderedText.length) {
            return getAtomicNodePosition(node, remaining.value >= renderedText.length);
        }

        remaining.value -= renderedText.length;
        return null;
    }

    if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? "";
        const length = stripCaretSpacers(text).length;
        if (remaining.value <= length) {
            return { node, offset: getDomTextOffsetForRenderedContentOffset(text, remaining.value) };
        }

        remaining.value -= length;
        return null;
    }

    for (const child of Array.from(node.childNodes)) {
        const position = findRenderedContentTextPositionInNode(child, remaining);
        if (position) {
            return position;
        }
    }

    return null;
}

function getRenderedContentChildText(node: Node): string {
    let text = "";
    for (const child of Array.from(node.childNodes)) {
        text += getRenderedContentText(child);
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

function getDomTextOffsetForRenderedContentOffset(text: string, offset: number): number {
    let renderedOffset = 0;

    for (let index = 0; index < text.length; index += 1) {
        if (text[index] === caretSpacerCharacter) {
            continue;
        }

        if (renderedOffset >= offset) {
            return index;
        }

        renderedOffset += 1;
    }

    return text.length;
}

function readRenderedContentRawText(node: Node): string | null {
    if (!(node instanceof HTMLElement)) {
        return null;
    }

    return node.dataset.sourceRaw ?? null;
}

function shouldIgnoreRenderedContentNode(node: Node): boolean {
    return node instanceof HTMLElement && node.dataset.sourceIgnore === "true";
}
