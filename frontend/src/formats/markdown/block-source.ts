import { headingTypes, type BlockType } from "../../editor/blocks/model";
import type { BlockSource } from "../../editor/blocks/rendering";
import {
    getTodoCheckbox,
    readBlockCodeFence,
    readBlockListMarker,
    readBlockListNumber,
    readBlockQuoteLevel,
    readBlockRuleMarker,
} from "../../editor/blocks/view";
import { createCodeFence } from "./code-fence";

export function hasMarkdownBlockSource(type: BlockType): boolean {
    return headingTypes.has(type) || ["list", "ordered-list", "todo", "quote", "code", "rule", "table"].includes(type);
}

export function readMarkdownBlockSource(block: HTMLElement, type: BlockType, text: string): BlockSource {
    if (headingTypes.has(type)) {
        return { prefix: `${"#".repeat(readHeadingLevel(type))} ` };
    }

    if (type === "list") {
        return { prefix: `${readBlockListMarker(block) ?? "-"} ` };
    }

    if (type === "ordered-list") {
        return { prefix: `${readBlockListNumber(block) ?? "1"}. ` };
    }

    if (type === "todo") {
        return { prefix: `${readBlockListMarker(block) ?? "-"} [${getTodoCheckbox(block).checked ? "x" : " "}] ` };
    }

    if (type === "quote") {
        const marker = ">".repeat(Math.max(1, readBlockQuoteLevel(block) ?? 1));
        return { prefix: `${marker} ` };
    }

    if (type === "code") {
        const fence = createCodeFence(text, readBlockCodeFence(block));
        const codeInfo = block.dataset.codeInfo ? ` ${block.dataset.codeInfo}` : "";
        return {
            prefix: `${fence}${codeInfo}`,
            suffix: fence,
        };
    }

    if (type === "rule") {
        return { atomic: readBlockRuleMarker(block) ?? "---" };
    }

    if (type === "table") {
        return { atomic: text };
    }

    return {};
}

function readHeadingLevel(type: BlockType): number {
    return Number(type.slice("heading-".length)) || 1;
}
