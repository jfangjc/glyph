import { parseMarkdownBlocksWithRanges } from "../../formats/markdown/parse";
import type { BlockIndex, SourceBlock } from "./types";

let nextBlockId = 1;

export function buildBlockIndex(doc: string, previous?: BlockIndex): BlockIndex {
    const previousIds = createPreviousBlockIdMap(doc, previous);
    const blocks = parseMarkdownBlocksWithRanges(doc).map((block): SourceBlock => {
        const sourceText = doc.slice(block.sourceFrom, block.sourceTo);
        const id = readReusableBlockId(previousIds, block.sourceFrom, block.sourceTo, sourceText);

        return {
            ...block,
            id,
            text: doc.slice(block.contentFrom, block.contentTo),
        };
    });

    if (doc.endsWith("\n")) {
        const lastLine = blocks[blocks.length - 1]?.lineTo ?? -1;
        blocks.push({
            id: readReusableBlockId(previousIds, doc.length, doc.length, ""),
            type: "paragraph",
            text: "",
            sourceFrom: doc.length,
            sourceTo: doc.length,
            contentFrom: doc.length,
            contentTo: doc.length,
            lineFrom: lastLine + 1,
            lineTo: lastLine + 1,
        });
    }

    return { blocks };
}

export function findSourceBlockAtOffset(index: BlockIndex, offset: number): SourceBlock | null {
    if (index.blocks.length === 0) {
        return null;
    }

    for (const block of index.blocks) {
        if (offset >= block.sourceFrom && offset <= block.sourceTo) {
            return block;
        }
    }

    const nextBlock = index.blocks.find((block) => offset < block.sourceFrom);
    if (nextBlock) {
        const previousBlock = index.blocks[index.blocks.indexOf(nextBlock) - 1];
        return previousBlock ?? nextBlock;
    }

    return index.blocks[index.blocks.length - 1];
}

export function getSourceBlockText(doc: string, block: SourceBlock): string {
    return doc.slice(block.contentFrom, block.contentTo);
}

function createPreviousBlockIdMap(doc: string, previous: BlockIndex | undefined): Map<string, string[]> {
    const ids = new Map<string, string[]>();
    if (!previous) {
        return ids;
    }

    for (const block of previous.blocks) {
        const key = createBlockIdentityKey(block.sourceFrom, block.sourceTo, doc.slice(block.sourceFrom, block.sourceTo));
        const entries = ids.get(key) ?? [];
        entries.push(block.id);
        ids.set(key, entries);
    }

    return ids;
}

function readReusableBlockId(
    previousIds: Map<string, string[]>,
    sourceFrom: number,
    sourceTo: number,
    sourceText: string,
): string {
    const key = createBlockIdentityKey(sourceFrom, sourceTo, sourceText);
    const existingIds = previousIds.get(key);
    return existingIds?.shift() ?? createBlockId();
}

function createBlockIdentityKey(sourceFrom: number, sourceTo: number, sourceText: string): string {
    return `${sourceFrom}:${sourceTo}:${sourceText}`;
}

function createBlockId(): string {
    const id = `block-${nextBlockId.toString(36)}`;
    nextBlockId += 1;
    return id;
}
