import type { Change, SelectionRange, SourceAffinity, Transaction } from "./types";

export function applyTransactionToDoc(
    doc: string,
    selection: SelectionRange,
    transaction: Transaction,
): { doc: string; selection: SelectionRange; changes: Change[] } {
    const changes = normalizeChanges(transaction.changes, doc.length);
    const nextDoc = applyChanges(doc, changes);
    const nextSelection = normalizeSelection(
        transaction.selection ?? mapSelection(selection, changes),
        nextDoc.length,
    );

    return {
        doc: nextDoc,
        selection: nextSelection,
        changes,
    };
}

export function normalizeSelection(selection: SelectionRange, docLength: number): SelectionRange {
    const anchor = clampOffset(selection.anchor, docLength);
    const head = clampOffset(selection.head, docLength);
    return {
        anchor,
        head,
        anchorAffinity: anchor === head ? selection.headAffinity ?? "downstream" : selection.anchorAffinity ?? "downstream",
        headAffinity: selection.headAffinity ?? "downstream",
        source: selection.source === true,
    };
}

export function mapSelection(selection: SelectionRange, changes: Change[]): SelectionRange {
    return {
        anchor: mapOffset(selection.anchor, changes, selection.anchorAffinity),
        head: mapOffset(selection.head, changes, selection.headAffinity),
        anchorAffinity: selection.anchorAffinity,
        headAffinity: selection.headAffinity,
        source: selection.source,
    };
}

export function mapOffset(
    offset: number,
    changes: Change[],
    affinity: SourceAffinity = "downstream",
): number {
    let delta = 0;

    for (const change of changes) {
        if (offset < change.from) {
            break;
        }

        if (
            offset === change.from &&
            change.from === change.to &&
            affinity === "upstream"
        ) {
            return change.from + delta;
        }

        if (offset <= change.to) {
            return change.from + delta + change.insert.length;
        }

        delta += change.insert.length - (change.to - change.from);
    }

    return offset + delta;
}

function normalizeChanges(changes: Change[], docLength: number): Change[] {
    const normalized = changes
        .map((change) => ({
            from: clampOffset(change.from, docLength),
            to: clampOffset(change.to, docLength),
            insert: change.insert,
        }))
        .map((change) => ({
            ...change,
            from: Math.min(change.from, change.to),
            to: Math.max(change.from, change.to),
        }))
        .sort((left, right) => left.from - right.from || left.to - right.to);

    for (let index = 1; index < normalized.length; index += 1) {
        if (normalized[index].from < normalized[index - 1].to) {
            throw new Error("Transaction changes must not overlap");
        }
    }

    return normalized;
}

function applyChanges(doc: string, changes: Change[]): string {
    if (changes.length === 0) {
        return doc;
    }

    let cursor = 0;
    let nextDoc = "";

    for (const change of changes) {
        nextDoc += doc.slice(cursor, change.from);
        nextDoc += change.insert;
        cursor = change.to;
    }

    nextDoc += doc.slice(cursor);
    return nextDoc;
}

function clampOffset(offset: number, docLength: number): number {
    if (!Number.isFinite(offset)) {
        return 0;
    }

    return Math.max(0, Math.min(Math.trunc(offset), docLength));
}
