import { caretSpacerCharacter } from "../../../editor/selection/rendered-content-dom";
import { findFirstInlineToken } from "../inline";

export function isCompleteInlineTokenSource(text: string): boolean {
    const tokenMatch = findFirstInlineToken(text);
    return Boolean(tokenMatch && tokenMatch.start === 0 && tokenMatch.token.raw.length === text.length);
}

export function readMarkdownTokenSourceFocusOffset(
    sourceLength: number,
    edge: "start" | "end",
    advanceIntoSource: boolean,
): number {
    if (!advanceIntoSource) {
        return edge === "start" ? 0 : sourceLength;
    }

    return edge === "start" ? Math.min(sourceLength, 1) : Math.max(0, sourceLength - 1);
}

export function getTokenBoundaryPositionSkippingSpacer(
    token: HTMLElement,
    childIndex: number,
    options: { edge: "start" | "end"; advanceAcrossAdjacentText: boolean },
): { node: Node; offset: number } {
    const parent = token.parentNode;
    if (!parent) {
        return { node: token, offset: 0 };
    }

    if (options.edge === "end") {
        const nextSibling = token.nextSibling;
        if (nextSibling?.nodeType === Node.TEXT_NODE && nextSibling.textContent?.startsWith(caretSpacerCharacter)) {
            return {
                node: nextSibling,
                offset: options.advanceAcrossAdjacentText ? Math.min(nextSibling.textContent.length, 2) : 1,
            };
        }

        return { node: parent, offset: childIndex + 1 };
    }

    const previousSibling = token.previousSibling;
    if (previousSibling?.nodeType === Node.TEXT_NODE && previousSibling.textContent?.endsWith(caretSpacerCharacter)) {
        return {
            node: previousSibling,
            offset: Math.max(0, previousSibling.textContent.length - (options.advanceAcrossAdjacentText ? 2 : 1)),
        };
    }

    if (options.advanceAcrossAdjacentText && previousSibling?.nodeType === Node.TEXT_NODE) {
        return { node: previousSibling, offset: Math.max(0, (previousSibling.textContent ?? "").length - 1) };
    }

    return { node: parent, offset: childIndex };
}
