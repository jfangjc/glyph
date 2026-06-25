import { headingTypes, type ParsedBlock } from "../../editor/blocks/model";
import { createCodeFence } from "./code-fence";
import { serializeListIndent } from "./utils";

export function serializeMarkdownDocument(_title: string, _usesTitle: boolean, blocks: ParsedBlock[]): string {
    const body = blocks.map(serializeMarkdownBlock).join("\n");

    return body ? `${body}\n` : "";
}

export function serializeMarkdownBlock(block: ParsedBlock): string {
    if (headingTypes.has(block.type)) {
        const id = block.headingIdExplicit && block.headingId ? ` {#${block.headingId}}` : "";
        return `${"#".repeat(Number(block.type.slice("heading-".length)))} ${block.text}${id}`;
    }

    if (block.type === "list") {
        return `${serializeListIndent(block.indent)}${block.listMarker ?? "-"} ${block.text}`;
    }

    if (block.type === "ordered-list") {
        return `${serializeListIndent(block.indent)}${block.listNumber ?? "1"}. ${block.text}`;
    }

    if (block.type === "todo") {
        return `${serializeListIndent(block.indent)}${block.listMarker ?? "-"} [${block.checked ? "x" : " "}] ${block.text}`;
    }

    if (block.type === "quote") {
        const marker = ">".repeat(Math.max(1, block.quoteLevel ?? 1));
        return block.text
            .split("\n")
            .map((line) => (line ? `${marker} ${line}` : marker))
            .join("\n");
    }

    if (block.type === "code") {
        const fence = createCodeFence(block.text, block.codeFence);
        const codeInfo = block.codeInfo ? ` ${block.codeInfo}` : "";
        const code = `${block.text}\n`;

        return `${fence}${codeInfo}\n${code}${fence}`;
    }

    if (block.type === "rule") {
        return block.ruleMarker ?? "---";
    }

    if (block.type === "table" || block.type === "definition-list" || block.type === "footnote-definition") {
        return block.text;
    }

    if (block.type === "math") {
        return block.mathSource ?? `$$\n${block.text}\n$$`;
    }

    if (block.type === "html") {
        return block.text;
    }

    return block.text;
}
