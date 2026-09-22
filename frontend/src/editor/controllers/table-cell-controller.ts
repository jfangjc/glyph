import { createTableTabTransaction } from "../../formats/markdown/commands";
import { escapeMarkdownTableCell, readMarkdownTableCellRange, readMarkdownTableColumnCount } from "../../formats/markdown/table";
import { findBlock } from "../blocks/view";
import { createSelectionBookmark, dispatch, getDocumentRevision, getEditorState, subscribeEditorState, type MappedSelectionBookmark } from "../core/store";
import { applyTransactionToDoc } from "../core/transaction";
import { buildBlockIndex } from "../../formats/markdown/block-index";
import type { Transaction } from "../core/types";
import { documentState } from "../../documents/document-state";
import { syncEditorDirtyState } from "../../documents/document-session";
import { setBlockSourceActive, syncDomSelectionFromState } from "../core/projection";
import { registerPendingEdit } from "../core/pending-edit";

type ActiveTableCellEditor = {
    input: HTMLInputElement;
    cell: HTMLTableCellElement;
    blockId: string;
    row: number;
    column: number;
    bookmark: MappedSelectionBookmark;
    sessionId: number;
    source: string;
    dispose: () => void;
    finishing: boolean;
};

type TableCellAddress = {
    blockId: string;
    row: number;
    column: number;
};

export function createTableCellController() {
    let activeTableCellEditor: ActiveTableCellEditor | null = null;
    let scheduledTableCellTimer: number | null = null;
    let unregisterScheduled: (() => void) | null = null;

    return {
        start: startTableCellEditor,
        finish: finishTableCellEditor,
        cancelScheduled: cancelScheduledTableCellEditor,
        isEditing: (cell: HTMLTableCellElement) => activeTableCellEditor?.cell === cell,
        focus: () => activeTableCellEditor?.input.focus({ preventScroll: true }),
        contains: (target: Node) => Boolean(activeTableCellEditor?.input.contains(target)),
    };

    function startTableCellEditor(cell: HTMLTableCellElement): void {
        cancelScheduledTableCellEditor();
        const row = Number.parseInt(cell.dataset.tableSourceRow ?? "", 10);
        const column = Number.parseInt(cell.dataset.tableSourceColumn ?? "", 10);
        const table = cell.closest<HTMLTableElement>(".markdown-table");
        const tableIndex = table ? Array.from(document.querySelectorAll(".markdown-table")).indexOf(table) : -1;
        finishTableCellEditor(true);
        if (!cell.isConnected && tableIndex >= 0 && Number.isFinite(row) && Number.isFinite(column)) {
            cell = document.querySelectorAll<HTMLTableElement>(".markdown-table")[tableIndex]
                ?.querySelector<HTMLTableCellElement>(
                    `[data-table-source-row="${row}"][data-table-source-column="${column}"]`,
                ) ?? cell;
        }
        const block = findBlock(cell);
        const blockId = block?.dataset.blockId;
        const sourceBlock = blockId ? getEditorState().blocks.blocks.find((candidate) => candidate.id === blockId) : null;
        if (!block || !blockId || !sourceBlock || !Number.isFinite(row) || !Number.isFinite(column)) return;
        const source = getEditorState().doc.slice(sourceBlock.sourceFrom, sourceBlock.sourceTo);
        const range = readMarkdownTableCellRange(source, row, column);
        if (!range) return;
        setBlockSourceActive(block, false);

        const input = document.createElement("input");
        const shell = document.getElementById("app");
        if (!shell) return;
        input.className = "table-cell-editor";
        input.type = "text";
        input.value = source.slice(range.start, range.end);
        input.setAttribute("aria-label", `Table row ${row === 0 ? "header" : row}, column ${column + 1}`);
        const positionInput = () => {
            const rect = cell.getBoundingClientRect();
            const container = shell.getBoundingClientRect();
            Object.assign(input.style, {
                left: `${rect.left - container.left + shell.scrollLeft - shell.clientLeft}px`,
                top: `${rect.top - container.top + shell.scrollTop - shell.clientTop}px`,
                width: `${rect.width}px`,
                height: `${rect.height}px`,
            });
        };
        positionInput();
        cell.dataset.tableCellEditing = "true";
        // The overlay shares the editor's scroll container, so scrolling does
        // not depend on a deferred viewport-coordinate update.
        shell.append(input);
        activeTableCellEditor = {
            input,
            cell,
            blockId,
            row,
            column,
            bookmark: createSelectionBookmark({ anchor: sourceBlock.sourceFrom + range.start, head: sourceBlock.sourceFrom + range.end }),
            sessionId: documentState.sessionId,
            source: input.value,
            dispose: () => {},
            finishing: false,
        };
        const active = activeTableCellEditor;
        let frame = 0;
        const position = () => {
            frame = 0;
            if (!cell.isConnected) {
                const owner = Array.from(document.querySelectorAll<HTMLElement>("#editor [data-block-id]"))
                    .find(block => block.dataset.blockId === active.blockId);
                const next = owner?.querySelector<HTMLTableCellElement>(`[data-table-source-row="${active.row}"][data-table-source-column="${active.column}"]`);
                if (!next || !readActiveRange(active)) { finishTableCellEditor(false); return; }
                observer.unobserve(cell);
                cell = next;
                active.cell = next;
                next.dataset.tableCellEditing = "true";
                observer.observe(next);
            }
            positionInput();
        };
        const schedulePosition = () => { if (!frame) frame = requestAnimationFrame(position); };
        const observer = new ResizeObserver(schedulePosition);
        observer.observe(cell);
        const surface = document.getElementById("editor");
        if (surface) observer.observe(surface);
        const layoutObserver = new MutationObserver(schedulePosition);
        for (const element of [document.documentElement, shell, document.getElementById("document-surface"), document.querySelector(".document-title-row")]) {
            if (element) layoutObserver.observe(element, { attributes: true, attributeFilter: ["style", "class", "hidden"] });
        }
        window.addEventListener("scroll", schedulePosition, true);
        window.addEventListener("resize", schedulePosition);
        window.visualViewport?.addEventListener("resize", schedulePosition);
        window.visualViewport?.addEventListener("scroll", schedulePosition);
        const unregister = registerPendingEdit({
            flush: () => finishTableCellEditor(true),
            cancel: () => { cancelScheduledTableCellEditor(); finishTableCellEditor(false); },
            isDirty: () => Boolean(readActiveRange(active)) && input.value !== active.source,
        });
        const unsubscribe = subscribeEditorState((_next, _previous, transaction) => {
            if (activeTableCellEditor !== active) return;
            if (transaction.annotations?.userEvent === "history" || !readActiveRange(active)) finishTableCellEditor(false);
            else schedulePosition();
        });
        active.dispose = () => {
            unregister();
            unsubscribe();
            observer.disconnect();
            layoutObserver.disconnect();
            if (frame) cancelAnimationFrame(frame);
            window.removeEventListener("scroll", schedulePosition, true);
            window.removeEventListener("resize", schedulePosition);
            window.visualViewport?.removeEventListener("resize", schedulePosition);
            window.visualViewport?.removeEventListener("scroll", schedulePosition);
            active.bookmark.dispose();
        };
        for (const type of ["pointerdown", "click", "beforeinput", "input", "copy", "cut", "paste"] as const) {
            input.addEventListener(type, (event) => event.stopPropagation());
        }
        let composing = false;
        input.addEventListener("compositionstart", () => { composing = true; });
        input.addEventListener("compositionend", () => { composing = false; });
        input.addEventListener("keydown", (event) => {
            if (composing || event.isComposing || event.keyCode === 229) return;
            if (event.key === "Escape") {
                event.stopPropagation();
                event.preventDefault();
                finishTableCellEditor(false, undefined, true);
            } else if (event.key === "Tab" || event.key === "Enter") {
                event.stopPropagation();
                event.preventDefault();
                finishTableCellEditor(true, event.shiftKey ? -1 : 1);
            }
        });
        input.addEventListener("input", syncEditorDirtyState);
        input.addEventListener("blur", () => finishTableCellEditor(true));
        input.focus({ preventScroll: true });
        input.select();
    }

    function finishTableCellEditor(commit: boolean, move?: -1 | 1, restoreFocus = false): void {
        const active = activeTableCellEditor;
        if (!active || active.finishing) return;
        cancelScheduledTableCellEditor();
        const range = readActiveRange(active);
        const nextCell = move ? readAdjacentTableCellAddress(active, move) : null;
        active.finishing = true;
        activeTableCellEditor = null;
        active.dispose();
        active.input.remove();
        active.cell.removeAttribute("data-table-cell-editing");
        if (!range || !commit) {
            if (range && restoreFocus) {
                dispatch({ changes: [], selection: { anchor: range.from, head: range.from, source: true }, annotations: { addToHistory: false } });
                syncDomSelectionFromState({ focus: "editor", scrollIntoView: true });
            }
            syncEditorDirtyState();
            return;
        }
        const value = escapeMarkdownTableCell(active.input.value);
        const state = getEditorState();
        const transaction: Transaction = {
            changes: value === active.source ? [] : [{ from: range.from, to: range.to, insert: value }],
            selection: { anchor: range.from + value.length, head: range.from + value.length },
            annotations: { userEvent: "input", historyMode: "discrete" },
        };
        let navigation: Transaction | null = null;
        if (move) {
            const applied = applyTransactionToDoc(state.doc, state.selection, transaction);
            const blocks = buildBlockIndex(applied.doc, { previousDoc: state.doc, previous: state.blocks, changes: applied.changes });
            navigation = createTableTabTransaction({ ...state, ...applied, blocks }, move);
            if (navigation) {
                const delta = value.length - (range.to - range.from);
                // Table traversal only appends a row after the edited cell.
                transaction.changes.push(...navigation.changes.map(change => ({ ...change, from: change.from - delta, to: change.to - delta })));
                transaction.selection = navigation.selection ?? applied.selection;
            }
        }
        dispatch(transaction);
        syncEditorDirtyState();
        if (navigation && nextCell) scheduleTableCellEditor(nextCell);
    }

    function readActiveRange(active: ActiveTableCellEditor): { from: number; to: number } | null {
        if (active.sessionId !== documentState.sessionId) return null;
        const selection = active.bookmark.read();
        const block = getEditorState().blocks.blocks.find(candidate => candidate.id === active.blockId && candidate.type === "table");
        if (!selection || !block) return null;
        const from = Math.min(selection.anchor, selection.head);
        const to = Math.max(selection.anchor, selection.head);
        const cell = readMarkdownTableCellRange(getEditorState().doc.slice(block.sourceFrom, block.sourceTo), active.row, active.column);
        return cell && block.sourceFrom + cell.start === from && block.sourceFrom + cell.end === to && getEditorState().doc.slice(from, to) === active.source
            ? { from, to } : null;
    }

    function readAdjacentTableCellAddress(active: ActiveTableCellEditor, move: -1 | 1): TableCellAddress | null {
        const sourceBlock = getEditorState().blocks.blocks.find((candidate) => candidate.id === active.blockId);
        if (!sourceBlock) return null;
        const source = getEditorState().doc.slice(sourceBlock.sourceFrom, sourceBlock.sourceTo);
        const columnCount = readMarkdownTableColumnCount(source);
        if (columnCount < 2) return null;

        let row = active.row;
        let column = active.column + move;
        if (column >= columnCount) {
            column = 0;
            row = active.row === 0 ? 2 : active.row + 1;
        } else if (column < 0) {
            column = columnCount - 1;
            row = active.row === 2 ? 0 : active.row - 1;
        }
        return row < 0 ? null : { blockId: active.blockId, row, column };
    }

    function scheduleTableCellEditor(address: TableCellAddress): void {
        cancelScheduledTableCellEditor();
        const sessionId = documentState.sessionId;
        const revision = getDocumentRevision();
        const bookmark = createSelectionBookmark();
        unregisterScheduled = registerPendingEdit({
            flush: cancelScheduledTableCellEditor,
            cancel: cancelScheduledTableCellEditor,
            isDirty: () => false,
        });
        const unregister = unregisterScheduled;
        unregisterScheduled = () => { unregister(); bookmark.dispose(); };
        // Selection projection for a newly inserted row can emit a deferred
        // selectionchange after the transaction. Open the next cell after that
        // browser task has settled so it cannot immediately steal focus back.
        scheduledTableCellTimer = window.setTimeout(() => {
            const valid = bookmark.read() !== null && sessionId === documentState.sessionId && revision === getDocumentRevision();
            cancelScheduledTableCellEditor();
            if (!valid) return;
            openTableCellEditor(address);
        }, 32);
    }

    function cancelScheduledTableCellEditor(): void {
        unregisterScheduled?.();
        unregisterScheduled = null;
        if (scheduledTableCellTimer === null) return;
        window.clearTimeout(scheduledTableCellTimer);
        scheduledTableCellTimer = null;
    }

    function openTableCellEditor(address: TableCellAddress): void {
        const table = Array.from(document.querySelectorAll<HTMLElement>("#editor [data-block-id]"))
            .find(block => block.dataset.blockId === address.blockId)?.querySelector(".markdown-table");
        const cell = table?.querySelector<HTMLTableCellElement>(
            `[data-table-source-row="${address.row}"][data-table-source-column="${address.column}"]`,
        ) ?? null;
        if (cell) startTableCellEditor(cell);
    }

}
