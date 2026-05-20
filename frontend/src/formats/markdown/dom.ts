import {
    getRenderedContentBoundaryOffset,
    getRenderedContentText,
    stripCaretSpacers,
} from "../../editor/selection/rendered-content-dom";

export type MarkdownTokenEdge = "start" | "end";

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

export function getMarkdownBoundaryOffset(current: Node, anchorNode: Node, anchorOffset: number): number {
    return getRenderedContentBoundaryOffset(current, anchorNode, anchorOffset);
}

export function getMarkdownText(node: Node): string {
    return getRenderedContentText(node);
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
