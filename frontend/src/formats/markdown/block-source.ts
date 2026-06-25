import { headingTypes, type BlockType } from "../../editor/blocks/model";
import type { BlockSource } from "../../editor/blocks/rendering";
import {
    getTodoCheckbox,
    readBlockCodeFence,
    readBlockListMarker,
    readBlockListNumber,
    readBlockQuoteLevel,
    readBlockRuleMarker,
    readBlockHeadingId,
    readBlockHeadingIdExplicit,
} from "../../editor/blocks/view";
import { createCodeFence } from "./code-fence";

export function hasMarkdownBlockSource(type: BlockType): boolean {
    return (
        headingTypes.has(type) ||
        ["list", "ordered-list", "todo", "quote", "code", "rule", "table", "math", "html", "definition-list"].includes(
            type,
        )
    );
}

export function readMarkdownBlockSource(block: HTMLElement, type: BlockType, text: string): BlockSource {
    if (headingTypes.has(type)) {
        const suffix =
            readBlockHeadingIdExplicit(block) && readBlockHeadingId(block)
                ? ` {#${readBlockHeadingId(block)}}`
                : undefined;
        return { prefix: `${"#".repeat(readHeadingLevel(type))} `, suffix };
    }

    if (type === "list") {
        return { prefix: `${readBlockListMarker(block) ?? "-"} `, prefixEditable: true };
    }

    if (type === "ordered-list") {
        return { prefix: `${readBlockListNumber(block) ?? "1"}. `, prefixEditable: true };
    }

    if (type === "todo") {
        return {
            prefix: `${readBlockListMarker(block) ?? "-"} [${getTodoCheckbox(block).checked ? "x" : " "}] `,
            prefixEditable: true,
        };
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

    if (type === "math") {
        return { atomic: block.dataset.mathSource ?? `$$\n${text}\n$$` };
    }

    if (type === "html" || type === "definition-list") {
        return { atomic: text };
    }

    return {};
}

function readHeadingLevel(type: BlockType): number {
    return Number(type.slice("heading-".length)) || 1;
}
