import { headingTypes, type BlockType, type ParsedBlock, type ParsedDocument } from "../../editor/block-model";

type MarkdownDocumentFile = {
    name: string;
    content: string;
};

export function parseMarkdownDocument(documentFile: MarkdownDocumentFile): ParsedDocument {
    const lines = documentFile.content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");

    if (lines.length > 1 && lines[lines.length - 1] === "") {
        lines.pop();
    }

    let title = titleFromFileName(documentFile.name);
    let usesTitle = false;
    let startLine = 0;
    const titleMatch = lines[0]?.match(/^#\s+(.+)$/);

    if (titleMatch) {
        title = titleMatch[1].trim() || title;
        usesTitle = true;
        startLine = lines[1] === "" ? 2 : 1;
    }

    const blocks: ParsedBlock[] = [];

    for (let index = startLine; index < lines.length; index += 1) {
        const line = lines[index];
        const fence = readCodeFence(line);

        if (fence) {
            const codeLines: string[] = [];
            index += 1;

            while (index < lines.length && !isClosingCodeFence(lines[index], fence.marker)) {
                codeLines.push(lines[index]);
                index += 1;
            }

            blocks.push({ type: "code", text: codeLines.join("\n"), codeInfo: fence.info });
            continue;
        }

        blocks.push(parseMarkdownLine(line));
    }

    return {
        title,
        usesTitle,
        blocks: blocks.length > 0 ? blocks : [{ type: "paragraph", text: "" }],
    };
}

export function serializeMarkdownDocument(title: string, usesTitle: boolean, blocks: ParsedBlock[]): string {
    const trimmedTitle = title.trim();
    const body = blocks.map(serializeMarkdownBlock).join("\n");
    const content = usesTitle && trimmedTitle ? `# ${trimmedTitle}${body ? `\n\n${body}` : ""}` : body;

    return content ? `${content}\n` : "";
}

function parseMarkdownLine(line: string): ParsedBlock {
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
        return {
            type: `heading-${headingMatch[1].length}` as BlockType,
            text: headingMatch[2],
        };
    }

    const todoMatch = line.match(/^-\s+\[([ xX])\]\s?(.*)$/);
    if (todoMatch) {
        return {
            type: "todo",
            text: todoMatch[2],
            checked: todoMatch[1].toLowerCase() === "x",
        };
    }

    const listMatch = line.match(/^(\s*)-\s+(.*)$/);
    if (listMatch) {
        return {
            type: "list",
            text: listMatch[2],
            indent: Math.min(Math.floor(listMatch[1].length / 2), 3),
        };
    }

    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
        return { type: "quote", text: quoteMatch[1] };
    }

    return { type: "paragraph", text: line };
}

function serializeMarkdownBlock(block: ParsedBlock): string {
    if (headingTypes.has(block.type)) {
        return `${"#".repeat(Number(block.type.slice("heading-".length)))} ${block.text}`;
    }

    if (block.type === "list") {
        return `${"  ".repeat(block.indent ?? 0)}- ${block.text}`;
    }

    if (block.type === "todo") {
        return `- [${block.checked ? "x" : " "}] ${block.text}`;
    }

    if (block.type === "quote") {
        return block.text
            .split("\n")
            .map((line) => (line ? `> ${line}` : ">"))
            .join("\n");
    }

    if (block.type === "code") {
        const fence = createCodeFence(block.text);
        const codeInfo = block.codeInfo ? ` ${block.codeInfo}` : "";
        const code = block.text.endsWith("\n") ? block.text : `${block.text}\n`;

        return `${fence}${codeInfo}\n${code}${fence}`;
    }

    return block.text;
}

function readCodeFence(line: string): { marker: string; info: string } | null {
    const match = line.trim().match(/^(`{3,}|~{3,})(.*)$/);
    if (!match) {
        return null;
    }

    return {
        marker: match[1],
        info: match[2].trim(),
    };
}

function isClosingCodeFence(line: string, fence: string): boolean {
    const trimmed = line.trim();
    const fenceCharacter = fence[0];

    return trimmed.startsWith(fenceCharacter.repeat(fence.length)) && trimmed.split("").every((char) => char === fenceCharacter);
}

function createCodeFence(text: string): string {
    const longestRun = text.match(/`+/g)?.reduce((longest, run) => Math.max(longest, run.length), 0) ?? 0;

    return "`".repeat(Math.max(3, longestRun + 1));
}

function titleFromFileName(fileName: string): string {
    const extensionIndex = fileName.lastIndexOf(".");
    const title = extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName;

    return title || "Untitled";
}
