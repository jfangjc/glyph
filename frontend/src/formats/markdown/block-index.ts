import type { BlockIndex, BlockIndexBuildContext, Change, SourceBlock } from "../../editor/core/types";
import { parseMarkdownBlocksWithRanges } from "./parse";

let nextBlockId = 1;

export function buildBlockIndex(doc: string, options?: BlockIndexBuildContext): BlockIndex {
    const incremental = options ? buildIncrementalBlockIndex(doc, options) : null;
    if (incremental) {
        return incremental;
    }

    const previousBlocks = options ? mapPreviousBlocks(options.previous.blocks, options.changes) : [];
    const parsedBlocks = parseMarkdownBlocksWithRanges(doc);
    const unchangedIds = options
        ? reserveUnchangedBlockIds(previousBlocks, parsedBlocks, options.previousDoc, doc)
        : new Map<number, string>();
    const blocks = parsedBlocks.map((block, index): SourceBlock => {
        const id = unchangedIds.get(index) ?? readReusableBlockId(previousBlocks, block);

        return {
            ...block,
            id,
            text: doc.slice(block.contentFrom, block.contentTo),
        };
    });

    if (doc.endsWith("\n")) {
        const lastLine = blocks[blocks.length - 1]?.lineTo ?? -1;
        blocks.push({
            id: readReusableBlockId(previousBlocks, {
                type: "paragraph",
                sourceFrom: doc.length,
                sourceTo: doc.length,
            }),
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

function reserveUnchangedBlockIds(
    previousBlocks: Array<SourceBlock & { mappedFrom: number; mappedTo: number; used: boolean }>,
    nextBlocks: Array<Omit<SourceBlock, "id" | "text">>,
    previousDoc: string,
    doc: string,
): Map<number, string> {
    const ids = new Map<number, string>();
    for (let index = 0; index < nextBlocks.length; index += 1) {
        const block = nextBlocks[index];
        const source = doc.slice(block.sourceFrom, block.sourceTo);
        const candidate = previousBlocks
            .filter((previous) => (
                !previous.used &&
                previous.type === block.type &&
                previousDoc.slice(previous.sourceFrom, previous.sourceTo) === source
            ))
            .sort((left, right) => (
                Math.abs(left.mappedFrom - block.sourceFrom) - Math.abs(right.mappedFrom - block.sourceFrom)
            ))[0];
        if (!candidate) {
            continue;
        }
        candidate.used = true;
        ids.set(index, candidate.id);
    }
    return ids;
}

function buildIncrementalBlockIndex(doc: string, options: BlockIndexBuildContext): BlockIndex | null {
    if (options.changes.length !== 1) {
        return null;
    }

    const change = options.changes[0];
    const removed = options.previousDoc.slice(change.from, change.to);
    if (change.insert.includes("\n") || removed.includes("\n")) {
        return null;
    }

    const affected = options.previous.blocks.find((block) => (
        change.from >= block.contentFrom &&
        change.to <= block.contentTo &&
        !(block.contentFrom === block.contentTo && change.from === block.contentFrom)
    ));
    if (!affected) {
        return null;
    }

    if (affected.type === "paragraph" && readChangedLine(doc, change).includes("|")) {
        return null;
    }

    const mapped = mapPreviousBlocks(options.previous.blocks, options.changes);
    const mappedAffected = mapped.find((block) => block.id === affected.id);
    if (!mappedAffected) {
        return null;
    }

    const affectedSource = doc.slice(mappedAffected.mappedFrom, mappedAffected.mappedTo);
    const reparsed = parseMarkdownBlocksWithRanges(affectedSource);
    if (reparsed.length !== 1 || reparsed[0].type !== affected.type) {
        return null;
    }

    const local = reparsed[0];
    const blocks = mapped.map((block): SourceBlock => {
        const base = stripMappedBlock(block);
        if (block.id === affected.id) {
            return {
                ...base,
                ...local,
                id: block.id,
                sourceFrom: block.mappedFrom + local.sourceFrom,
                sourceTo: block.mappedFrom + local.sourceTo,
                contentFrom: block.mappedFrom + local.contentFrom,
                contentTo: block.mappedFrom + local.contentTo,
                lineFrom: affected.lineFrom,
                lineTo: affected.lineTo,
                text: doc.slice(block.mappedFrom + local.contentFrom, block.mappedFrom + local.contentTo),
            };
        }

        const sourceFrom = block.mappedFrom;
        const sourceTo = block.mappedTo;
        const contentFrom = mapRangeBoundary(block.contentFrom, options.changes, "start");
        const contentTo = mapRangeBoundary(block.contentTo, options.changes, "end");
        return {
            ...base,
            sourceFrom,
            sourceTo,
            contentFrom,
            contentTo,
            text: doc.slice(contentFrom, contentTo),
        };
    });

    return { blocks };
}

function readChangedLine(doc: string, change: Change): string {
    const previousBreak = change.from > 0 ? doc.lastIndexOf("\n", change.from - 1) : -1;
    const lineFrom = previousBreak + 1;
    const insertedTo = change.from + change.insert.length;
    const nextBreak = doc.indexOf("\n", insertedTo);
    const lineTo = nextBreak < 0 ? doc.length : nextBreak;
    return doc.slice(lineFrom, lineTo);
}

function stripMappedBlock(
    block: SourceBlock & { mappedFrom: number; mappedTo: number; used: boolean },
): SourceBlock {
    const { mappedFrom: _mappedFrom, mappedTo: _mappedTo, used: _used, ...sourceBlock } = block;
    return sourceBlock;
}

function readReusableBlockId(
    previousBlocks: Array<SourceBlock & { mappedFrom: number; mappedTo: number; used: boolean }>,
    block: Pick<SourceBlock, "type" | "sourceFrom" | "sourceTo">,
): string {
    const exact = previousBlocks.find((candidate) => (
        !candidate.used &&
        candidate.type === block.type &&
        candidate.mappedFrom === block.sourceFrom &&
        candidate.mappedTo === block.sourceTo
    ));
    const overlapping = exact ?? previousBlocks.find((candidate) => (
        !candidate.used &&
        candidate.type === block.type &&
        rangesOverlap(candidate.mappedFrom, candidate.mappedTo, block.sourceFrom, block.sourceTo)
    ));
    if (!overlapping) {
        return createBlockId();
    }

    overlapping.used = true;
    return overlapping.id;
}

function mapPreviousBlocks(
    blocks: SourceBlock[],
    changes: Change[],
): Array<SourceBlock & { mappedFrom: number; mappedTo: number; used: boolean }> {
    return blocks.map((block) => ({
        ...block,
        mappedFrom: mapRangeBoundary(block.sourceFrom, changes, "start"),
        mappedTo: mapRangeBoundary(block.sourceTo, changes, "end"),
        used: false,
    }));
}

function mapRangeBoundary(offset: number, changes: Change[], edge: "start" | "end"): number {
    let delta = 0;
    for (const change of changes) {
        if (offset < change.from || edge === "start" && offset === change.from) {
            break;
        }
        if (offset <= change.to) {
            return change.from + delta + (edge === "end" ? change.insert.length : 0);
        }
        delta += change.insert.length - (change.to - change.from);
    }
    return offset + delta;
}

function rangesOverlap(leftFrom: number, leftTo: number, rightFrom: number, rightTo: number): boolean {
    if (leftFrom === leftTo || rightFrom === rightTo) {
        return leftFrom === rightFrom;
    }
    return leftFrom < rightTo && rightFrom < leftTo;
}

function createBlockId(): string {
    const id = `block-${nextBlockId.toString(36)}`;
    nextBlockId += 1;
    return id;
}
