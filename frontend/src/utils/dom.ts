export function getElement<TElement extends HTMLElement>(id: string): TElement {
    const element = document.getElementById(id);
    if (!element) {
        throw new Error(`Missing element: ${id}`);
    }

    return element as TElement;
}

export function getPlainTextBoundaryOffset(current: Node, anchorNode: Node, anchorOffset: number): number {
    if (current === anchorNode) {
        if (current.nodeType === Node.TEXT_NODE) {
            return (current.textContent ?? "").slice(0, anchorOffset).length;
        }

        return Array.from(current.childNodes)
            .slice(0, Math.max(0, anchorOffset))
            .reduce((offset, child) => offset + (child.textContent ?? "").length, 0);
    }

    let offset = 0;
    for (const child of Array.from(current.childNodes)) {
        if (child === anchorNode || child.contains(anchorNode)) {
            return offset + getPlainTextBoundaryOffset(child, anchorNode, anchorOffset);
        }

        offset += (child.textContent ?? "").length;
    }

    return offset;
}
