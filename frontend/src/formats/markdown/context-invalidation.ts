import { sourceBlocksInRange, type EditorState, type Transaction } from "../../editor/core/types";

export function shouldRefreshMarkdownRenderContext(
    state: EditorState,
    previous: EditorState | undefined,
    transaction: Transaction | undefined,
): boolean {
    if (!previous || !transaction) {
        return true;
    }

    const affectsContext = (snapshot: EditorState, from: number, to: number) =>
        Array.from(sourceBlocksInRange(snapshot.blocks, from, to)).some(block =>
            block.type.startsWith("heading-") || block.type === "reference" ||
            block.type === "footnote-definition" || block.text.includes("[^"));
    let delta = 0;
    for (const change of transaction.changes) {
        const removed = previous.doc.slice(change.from, change.to);
        if (/[\n#\[\]<>`$|:]/.test(change.insert + removed)) {
            return true;
        }

        if (affectsContext(previous, change.from, change.to) ||
            affectsContext(state, change.from + delta, change.from + delta + change.insert.length)) {
            return true;
        }
        delta += change.insert.length - (change.to - change.from);
    }

    return false;
}

