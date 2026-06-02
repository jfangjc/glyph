import {
    getBlockContent,
} from "../../../editor/blocks/view";
import {
    getBlockSourceElement,
} from "../../../editor/blocks/rendering";
import { getRenderedContentText } from "../../../editor/selection/rendered-content-dom";

export type CodeBlockSourceParts = {
    prefix: string;
    text: string;
    suffix: string;
};

export function getCodeBlockRawMarkdown(block: HTMLElement): string {
    const source = readCodeBlockSourceParts(block);

    return source ? `${source.prefix}\n${source.text}\n${source.suffix}` : getRenderedContentText(getBlockContent(block));
}

export function readCodeBlockSourceParts(block: HTMLElement): CodeBlockSourceParts | null {
    const content = getBlockContent(block);
    const prefix = getBlockSourceElement(content, "prefix");
    const body = content.querySelector<HTMLElement>(".markdown-code-block-body");
    const suffix = getBlockSourceElement(content, "suffix");

    if (!prefix || !body || !suffix) {
        return null;
    }

    return {
        prefix: prefix.textContent ?? "",
        text: getRenderedContentText(body),
        suffix: suffix.textContent ?? "",
    };
}

export function isValidCodeBlockSource(source: { prefix: string; suffix: string }): boolean {
    const opening = source.prefix.trim().match(/^(`{3,}|~{3,})(.*)$/);
    if (!opening) {
        return false;
    }

    const marker = opening[1];
    const closing = source.suffix.trim();
    const markerCharacter = marker[0];

    return (
        closing.length >= marker.length &&
        closing.split("").every((character) => character === markerCharacter)
    );
}

export function serializeInvalidCodeBlockSource(source: CodeBlockSourceParts): string {
    const lines = [source.prefix, source.text];
    if (source.suffix !== "") {
        lines.push(source.suffix);
    }

    return lines.join("\n");
}
