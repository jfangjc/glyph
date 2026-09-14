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
    const readReusableId = createReusableBlockIdReader(previousBlocks);
    const blocks = parsedBlocks.map((block, index): SourceBlock => {
        const id = unchangedIds.get(index) ?? readReusableId(block);

        return {
            ...block,
            id,
            text: doc.slice(block.contentFrom, block.contentTo),
        };
    });

    if (doc.endsWith("\n")) {
        const eofLine = doc.split("\n").length - 1;
        blocks.push({
            id: readReusableId({
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
            lineFrom: eofLine,
            lineTo: eofLine,
        });
    }

    return { blocks };
}

type MappedBlock = SourceBlock & { mappedFrom: number; mappedTo: number; used: boolean };
type CandidateGroup = { position: number; blocks: MappedBlock[]; cursor: number };
type SourceCandidates = { groups: CandidateGroup[]; right: number; left: CandidateGroup[] };

function reserveUnchangedBlockIds(
    previousBlocks: MappedBlock[],
    nextBlocks: Array<Omit<SourceBlock, "id" | "text">>,
    previousDoc: string,
    doc: string,
): Map<number, string> {
    const byType = new Map<SourceBlock["type"], Map<string, SourceCandidates>>();
    for (const block of previousBlocks) {
        let bySource = byType.get(block.type);
        if (!bySource) byType.set(block.type, bySource = new Map());
        const source = previousDoc.slice(block.sourceFrom, block.sourceTo);
        let bucket = bySource.get(source);
        if (!bucket) bySource.set(source, bucket = { groups: [], right: 0, left: [] });
        let group = bucket.groups[bucket.groups.length - 1];
        if (!group || group.position !== block.mappedFrom) {
            group = { position: block.mappedFrom, blocks: [], cursor: 0 };
            bucket.groups.push(group);
        }
        group.blocks.push(block);
    }

    const ids = new Map<number, string>();
    // Parser ranges and mapped previous ranges are ordered. Each group crosses
    // the sweep once; duplicates at one position are consumed in original order.
    for (let index = 0; index < nextBlocks.length; index += 1) {
        const block = nextBlocks[index];
        const bucket = byType.get(block.type)?.get(doc.slice(block.sourceFrom, block.sourceTo));
        if (!bucket) continue;
        while (bucket.right < bucket.groups.length && bucket.groups[bucket.right].position <= block.sourceFrom) {
            const group = bucket.groups[bucket.right++];
            if (group.cursor < group.blocks.length) bucket.left.push(group);
        }
        const left = bucket.left[bucket.left.length - 1];
        const right = bucket.groups[bucket.right];
        const group = left && (!right || block.sourceFrom - left.position <= right.position - block.sourceFrom)
            ? left : right;
        if (!group) continue;
        const candidate = group.blocks[group.cursor++];
        candidate.used = true;
        ids.set(index, candidate.id);
        if (group.cursor === group.blocks.length) {
            if (group === left) bucket.left.pop();
            else bucket.right += 1;
        }
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

// Skip consumed candidates with path compression. Binary searches locate the
// first eligible range without rescanning earlier used entries on each query.
class AvailableBlocks {
    private readonly next: number[];

    constructor(readonly blocks: MappedBlock[]) {
        this.next = blocks.map((_, index) => index);
    }

    first(index: number): MappedBlock | undefined {
        let cursor = index;
        while (cursor < this.blocks.length && this.blocks[cursor].used) {
            if (this.next[cursor] === cursor) this.next[cursor] = cursor + 1;
            cursor = this.next[cursor];
        }
        while (index < cursor) {
            const next = this.next[index];
            this.next[index] = cursor;
            index = next;
        }
        return this.blocks[cursor];
    }

    lowerBound(predicate: (block: MappedBlock) => boolean): MappedBlock | undefined {
        let low = 0;
        let high = this.blocks.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (predicate(this.blocks[middle])) high = middle;
            else low = middle + 1;
        }
        return this.first(low);
    }
}

function createReusableBlockIdReader(previousBlocks: MappedBlock[]) {
    const exact = new Map<string, MappedBlock[]>();
    const types = new Map<SourceBlock["type"], MappedBlock[]>();
    const order = new Map<MappedBlock, number>();
    for (const [index, block] of previousBlocks.entries()) {
        if (block.used) continue;
        order.set(block, index);
        const key = `${block.type}:${block.mappedFrom}:${block.mappedTo}`;
        let matching = exact.get(key);
        if (!matching) exact.set(key, matching = []);
        matching.push(block);
        let typed = types.get(block.type);
        if (!typed) types.set(block.type, typed = []);
        typed.push(block);
    }
    const exactCandidates = new Map(Array.from(exact, ([key, blocks]) => [key, new AvailableBlocks(blocks)]));
    const byType = new Map(Array.from(types, ([type, blocks]) => [type, {
        all: new AvailableBlocks(blocks),
        nonempty: new AvailableBlocks(blocks.filter(block => block.mappedFrom !== block.mappedTo)),
        empty: new AvailableBlocks(blocks.filter(block => block.mappedFrom === block.mappedTo)),
    }]));

    return (block: Pick<SourceBlock, "type" | "sourceFrom" | "sourceTo">): string => {
        let candidate = exactCandidates.get(`${block.type}:${block.sourceFrom}:${block.sourceTo}`)?.first(0);
        const typed = byType.get(block.type);
        if (!candidate && typed) {
            if (block.sourceFrom === block.sourceTo) {
                const sameStart = typed.all.lowerBound(previous => previous.mappedFrom >= block.sourceFrom);
                if (sameStart?.mappedFrom === block.sourceFrom) candidate = sameStart;
            } else {
                // Nonempty ranges have monotonically ordered ends as well as
                // starts. Empty blocks overlap only at the same start offset.
                const overlap = typed.nonempty.lowerBound(previous => previous.mappedTo > block.sourceFrom);
                if (overlap && overlap.mappedFrom < block.sourceTo) candidate = overlap;
                const empty = typed.empty.lowerBound(previous => previous.mappedFrom >= block.sourceFrom);
                if (empty?.mappedFrom === block.sourceFrom && (!candidate || order.get(empty)! < order.get(candidate)!)) {
                    candidate = empty;
                }
            }
        }
        if (!candidate) return createBlockId();
        candidate.used = true;
        return candidate.id;
    };
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

function createBlockId(): string {
    const id = `block-${nextBlockId.toString(36)}`;
    nextBlockId += 1;
    return id;
}
