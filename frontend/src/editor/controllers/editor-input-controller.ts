import type { EditorCommand } from "../../app/commands";
import { documentState } from "../../documents/document-state";
import {
    extensionForImageMimeType,
    hasMeaningfulNonImageClipboardHtml,
    readClipboardImages,
    readNativePlainClipboard,
    readNativeRichClipboard,
    writeNativeClipboard,
} from "../../bridge/clipboard";
import {
    persistImageFiles,
    pruneUnreferencedPendingImages,
    stagePendingImages,
} from "../../formats/markdown/pending-images";
import {
    createPendingInlineFormatInsertTransaction,
} from "../../formats/markdown/commands";
import { createTableCellController } from "./table-cell-controller";
import {
    matchesShortcutCommand,
    readInlineFormatShortcut,
} from "../../app/keymap";
import type {
    BlockFormatCommand,
    InsertContentCommand,
    ClipboardPayload,
    ClipboardReadResult,
    ClipboardSelectionContext,
    DocumentFormat,
    InlineFormatCommand,
} from "../../formats/types";
import {
    findSourceBlockAtOffset,
    isSourceSelection,
    type SourceBlock,
} from "../core/types";
import {
    findBlock,
    getEditorBlocks,
    invalidateBlockRenderCache,
} from "../blocks/view";
import {
    createDeleteTransaction,
    createInsertTextTransaction,
    createPasteTransaction,
    createIndentSourceTransaction,
} from "../core/commands";
import {
    createSelectionBookmark,
    canRedoSourceHistory,
    canUndoSourceHistory,
    dispatch,
    flushSourceHistoryBatch,
    getEditorState,
    getDocumentRevision,
    subscribeEditorState,
    redoSourceHistory,
    undoSourceHistory,
} from "../core/store";
import {
    activateSourceToken,
    clearSourceReveal,
    clearInlineTypingSourceReveal,
    domPointToSourceOffset,
    moveSourceSelectionVertically,
    readVisualLineBoundary,
    selectionTouchesSource,
    resetVerticalNavigationAffinity,
    readSourceTokenDocumentRange,
    syncDomSelectionFromState,
    syncStateSelectionFromDom,
    setCompositionSurface,
} from "../core/projection";
import { reportEditorError } from "../editor-status";
import { resolveListNavigationAffinity, resolveVisibleSourceOffset } from "../core/types";
import { replaceEditorBlocksFromSourceState } from "../../documents/document-render-context";
import { handleEditorMouseDown as handleEditorMouseDownCommand } from "../pointer-interactions";
import { getCaretPositionFromPoint } from "../selection/caret";
import {
    nextGraphemeBoundary,
    nextLineBoundary,
    nextWordBoundary,
    previousGraphemeBoundary,
    previousLineBoundary,
    previousWordBoundary,
} from "../../utils/text-boundaries";

type ActiveInlineObjectSelection = {
    token: HTMLElement;
    toolbar: HTMLElement;
    from: number;
    to: number;
};

type EditorInputControllerOptions = {
    syncActiveBlockIndicator: (block: HTMLElement | null) => void;
    getActiveDocumentFormat: () => DocumentFormat;
    getActiveFilePath: () => string | null;
    isSourceMode: () => boolean;
};

export function createEditorInputController(options: EditorInputControllerOptions) {
    let isComposingText = false;
    let preCompositionSourceSelection = getEditorState().selection;
    let compositionLease: { sessionId: number; revision: number } | null = null;
    let compositionTargetCaptured = false;
    let clipboardOperationId = 0;
    let internalDrag: {
        sessionId: number;
        revision: number;
        from: number;
        to: number;
        source: string;
    } | null = null;
    const tableCellController = createTableCellController();
    let activeInlineObject: ActiveInlineObjectSelection | null = null;
    const pendingInlineFormats = new Set<Exclude<InlineFormatCommand, "link">>();
    let pendingInlineFormatOffset: number | null = null;
    subscribeEditorState(() => {
        if (compositionLease && (compositionLease.sessionId !== documentState.sessionId || compositionLease.revision !== getDocumentRevision())) {
            cancelComposition();
        }
    });

    return {
        deactivate,
        containsExternalInteractionTarget,
        handleEditorMouseDown,
        handleEditorChange,
        handleEditorKeydown,
        handleEditorBeforeInput,
        handleEditorCompositionStart,
        handleEditorCompositionEnd,
        handleEditorPaste,
        handleEditorCopy,
        handleEditorCut,
        handleEditorDragStart,
        handleEditorDragEnd,
        handleEditorDragOver,
        handleEditorDrop,
        handleEditorClick,
        handleEditorSelectionChange,
        isComposingText: () => isComposingText,
        executeCommand,
        canExecuteCommand,
        isCommandActive,
    };

    async function executeCommand(command: EditorCommand, focusOwner?: Element | null): Promise<void> {
        const commandFocusOwner = focusOwner ?? document.activeElement;
        const activeTextInput = isTextEntryElement(commandFocusOwner) ? commandFocusOwner : null;

        if (command === "undo" || command === "redo") {
            if (activeTextInput) {
                activeTextInput.focus({ preventScroll: true });
                document.execCommand(command);
            } else {
                if (command === "undo") undoSourceHistory();
                else redoSourceHistory();
            }
            return;
        }

        if (isInlineFormatCommand(command)) {
            if (!supportsRichSourceEditing() || activeTextInput) {
                return;
            }
            syncSourceSelectionForCommand();
            const formatCommand = readInlineFormatCommand(command);
            const state = getEditorState();
            if (
                formatCommand !== "link" &&
                state.selection.anchor === state.selection.head &&
                canUsePendingInlineFormat(state)
            ) {
                togglePendingInlineFormat(formatCommand, state.selection.head);
                syncDomSelectionFromState({ focus: "editor", scrollIntoView: true });
                return;
            }
            clearPendingInlineFormats();
            const transaction = options.getActiveDocumentFormat().editing?.createInlineFormatTransaction?.(
                state,
                formatCommand,
            );
            if (transaction) {
                dispatch(transaction);
            } else {
                reportEditorError("No formattable text selected");
            }
            return;
        }

        if (command.startsWith("block:") || command.startsWith("insert:")) {
            if (!supportsRichSourceEditing() || activeTextInput) {
                return;
            }
            clearPendingInlineFormats();
            syncSourceSelectionForCommand();
            const state = getEditorState();
            const transaction = command.startsWith("block:")
                ? options.getActiveDocumentFormat().editing?.createBlockFormatTransaction?.(
                    state,
                    command.slice("block:".length) as BlockFormatCommand,
                )
                : options.getActiveDocumentFormat().editing?.createInsertContentTransaction?.(
                    state,
                    command.slice("insert:".length) as InsertContentCommand,
                );
            if (transaction) {
                dispatch(transaction);
                syncDomSelectionFromState({ focus: "editor", scrollIntoView: true });
            }
            return;
        }

        if (activeTextInput) {
            if (isTextInputCommand(command)) {
                await executeTextInputClipboardCommand(activeTextInput, command);
            }
            return;
        }

        if (command === "select-all") {
            dispatch({
                changes: [],
                selection: { anchor: 0, head: getEditorState().doc.length, source: true },
                annotations: { userEvent: "programmatic", addToHistory: false },
            });
            syncDomSelectionFromState({ scrollIntoView: true });
            return;
        }

        if (command === "paste") {
            syncSourceSelectionForCommand();
            const bookmark = createSelectionBookmark();
            try {
                const result = supportsRichSourceEditing()
                    ? await readNativeRichClipboard(html => options.getActiveDocumentFormat().clipboard?.convertHtml?.(html) ?? html)
                    : { kind: "plain", value: await readNativePlainClipboard() } as ClipboardReadResult;
                const selection = bookmark.read();
                if ("warning" in result && result.warning) {
                    reportEditorError(result.warning);
                }
                if (result.kind === "images") {
                    if (selection) {
                        await pasteSourceImages(result.files, bookmark);
                        return;
                    }
                } else if (result.value && selection) {
                    const state = getEditorState();
                    dispatch(createSourcePasteTransaction(
                        { ...state, selection },
                        prepareVirtualEofInsertion(result.value, selection),
                    ));
                }
            } catch (error) {
                console.error("Failed to read clipboard:", error);
                reportEditorError("Could not read the clipboard.");
            } finally {
                bookmark.dispose();
            }
            return;
        }

        syncSourceSelectionForCommand();
        const state = getEditorState();
        const clipboardSelection = readClipboardSelection(state);
        if (!clipboardSelection) {
            return;
        }

        const selectedText = state.doc.slice(clipboardSelection.anchor, clipboardSelection.head);
        const bookmark = createSelectionBookmark(clipboardSelection);
        const clipboardLease = {
            sessionId: documentState.sessionId,
            operationId: ++clipboardOperationId,
            revision: state.revision,
            selectedText,
            focusOwner: document.activeElement,
        };
        try {
            await writeNativeClipboard(createClipboardPayload(), supportsRichSourceEditing());
            if (command === "cut") {
                const selection = bookmark.read();
                if (
                    selection &&
                    clipboardLease.sessionId === documentState.sessionId &&
                    clipboardLease.operationId === clipboardOperationId
                ) {
                    const current = getEditorState();
                    const from = Math.min(selection.anchor, selection.head);
                    const to = Math.max(selection.anchor, selection.head);
                    if (current.doc.slice(from, to) === clipboardLease.selectedText) {
                        const transaction = createSourceDeleteTransaction(
                            { ...current, selection },
                            "forward",
                            "grapheme",
                        );
                        if (transaction) {
                            dispatch(transaction);
                        }
                    } else {
                        reportEditorError("The selection changed, so Cut was completed as Copy.");
                    }
                } else {
                    reportEditorError("The document changed, so Cut was completed as Copy.");
                }
            }
        } catch (error) {
            console.error("Failed to write clipboard:", error);
            reportEditorError("Could not write to the clipboard.");
        } finally {
            bookmark.dispose();
        }
    }

    function syncSourceSelectionForCommand(): void {
        syncStateSelectionFromDom();
    }

    async function executeTextInputClipboardCommand(
        input: HTMLInputElement | HTMLTextAreaElement,
        command: "copy" | "cut" | "paste" | "select-all",
    ): Promise<void> {
        if (command === "select-all") {
            input.select();
            return;
        }

        const start = input.selectionStart ?? 0;
        const end = input.selectionEnd ?? start;
        if (command === "copy" || command === "cut") {
            if (start === end) return;
            const value = input.value.slice(start, end);
            await writeNativeClipboard({ markdown: value, plainText: value, html: escapeClipboardText(value) }, false);
            if (command === "cut") {
                input.setRangeText("", start, end, "start");
                input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteByCut" }));
            }
            return;
        }

        const value = await readNativePlainClipboard();
        input.setRangeText(value, start, end, "end");
        input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: value }));
    }

    function escapeClipboardText(value: string): string {
        return `<pre>${value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`;
    }

    function deactivate(): void {
        cancelComposition();
        tableCellController.cancelScheduled();
        clearPendingInlineFormats();
        clearInlineObjectSelection();
        tableCellController.finish(true);
        flushSourceHistoryBatch();
        resetVerticalNavigationAffinity();
        clearSourceReveal();
        options.syncActiveBlockIndicator(null);
    }

    function containsExternalInteractionTarget(target: EventTarget | null): boolean {
        return target instanceof Node && Boolean(
            tableCellController.contains(target) ||
            activeInlineObject?.toolbar.contains(target)
        );
    }

    function handleEditorMouseDown(event: PointerEvent): void {
        clearPendingInlineFormats();
        clearInlineTypingSourceReveal();
        resetVerticalNavigationAffinity();
        flushSourceHistoryBatch();
        const target = event.target as Element | null;
        const tableCell = target?.closest<HTMLTableCellElement>(".markdown-table th, .markdown-table td");
        if (
            tableCell &&
            event.button === 0 &&
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.shiftKey
        ) {
            event.preventDefault();
            event.stopPropagation();
            if (event.detail > 1) {
                const block = findBlock(tableCell);
                tableCellController.finish(true);
                if (block) {
                    editBlockObjectSource(block, true);
                }
                return;
            }
            if (tableCellController.isEditing(tableCell)) {
                tableCellController.focus();
            } else {
                tableCellController.start(tableCell);
            }
            return;
        }

        const inlineObject = target?.closest<HTMLElement>(".markdown-image-token, .markdown-math-token");
        if (
            inlineObject &&
            event.button === 0 &&
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.shiftKey
        ) {
            event.preventDefault();
            event.stopPropagation();
            if (activeInlineObject?.token === inlineObject) {
                editInlineObjectSource(inlineObject);
            } else {
                selectInlineObject(inlineObject);
            }
            return;
        }
        clearInlineObjectSelection();
        handleEditorMouseDownCommand(event);
    }

    function handleEditorChange(event: Event): void {
        const target = event.target;
        if (target instanceof HTMLInputElement && target.classList.contains("todo-checkbox")) {
            const block = findBlock(target);
            const blockId = block?.dataset.blockId;
            const blockIndex = block ? getEditorBlocks().indexOf(block) : -1;
            const editor = block?.closest<HTMLElement>(".block-editor");
            const transaction = blockId
                ? options.getActiveDocumentFormat().editing?.createCheckboxToggleTransaction?.(getEditorState(), blockId)
                : null;
            if (transaction) {
                dispatch(transaction);
                window.requestAnimationFrame(() => {
                    const activeElement = document.activeElement;
                    if (
                        activeElement !== document.body &&
                        activeElement !== document.documentElement &&
                        activeElement !== editor &&
                        !(activeElement instanceof HTMLInputElement && activeElement.classList.contains("todo-checkbox"))
                    ) {
                        return;
                    }
                    getEditorBlocks()[blockIndex]
                        ?.querySelector<HTMLInputElement>(".todo-checkbox")
                        ?.focus({ preventScroll: true });
                });
            }
            return;
        }

    }

    function handleEditorKeydown(event: KeyboardEvent): void {
        if (matchesShortcutCommand(event, "edit:undo", "editor")) {
            event.preventDefault();
            void executeCommand("undo");
            return;
        }

        if (matchesShortcutCommand(event, "edit:redo", "editor")) {
            event.preventDefault();
            void executeCommand("redo");
            return;
        }

        if (handleSourceKeydown(event)) {
            return;
        }
    }

    function handleEditorBeforeInput(event: InputEvent): void {
        clearInlineObjectSelection();
        if (isComposingText && event.inputType.includes("Composition")) {
            const targetRange = event.getTargetRanges?.()[0];
            const editor = document.getElementById("editor");
            if (!compositionTargetCaptured && targetRange && editor?.contains(targetRange.startContainer) && editor.contains(targetRange.endContainer)) {
                preCompositionSourceSelection = {
                    ...preCompositionSourceSelection,
                    anchor: domPointToSourceOffset(targetRange.startContainer, targetRange.startOffset),
                    head: domPointToSourceOffset(targetRange.endContainer, targetRange.endOffset),
                };
            }
            compositionTargetCaptured = true;
            return;
        }
        const undoKind = event.inputType === "historyUndo"
            ? "history-undo"
            : event.inputType === "historyRedo" ? "history-redo" : null;
        if (undoKind === "history-undo" || undoKind === "history-redo") {
            event.preventDefault();
            if (undoKind === "history-undo") {
                undoSourceHistory();
            } else {
                redoSourceHistory();
            }
            return;
        }

        handleSourceBeforeInput(event);
    }

    function handleEditorCompositionStart(): void {
        clearPendingInlineFormats();
        syncStateSelectionFromDom();
        isComposingText = true;
        compositionTargetCaptured = false;
        preCompositionSourceSelection = getEditorState().selection;
        compositionLease = {
            sessionId: documentState.sessionId,
            revision: getDocumentRevision(),
        };
        flushSourceHistoryBatch();
        setCompositionSurface(document.getElementById("editor"));
    }

    function canExecuteCommand(command: EditorCommand): boolean {
        if (command === "undo") return canUndoSourceHistory();
        if (command === "redo") return canRedoSourceHistory();
        if (command === "paste" || command === "select-all") return true;
        const state = getEditorState();
        if (command === "copy" || command === "cut") {
            return state.selection.anchor !== state.selection.head;
        }
        if (isInlineFormatCommand(command) || command.startsWith("block:") || command.startsWith("insert:")) {
            return supportsRichSourceEditing();
        }
        return true;
    }

    function isCommandActive(command: EditorCommand): boolean {
        const state = getEditorState();
        const block = findSourceBlockAtOffset(state.blocks, state.selection.head);
        if (command.startsWith("block:")) {
            return block?.type === command.slice("block:".length);
        }
        if (!isInlineFormatCommand(command) || !block) {
            return false;
        }
        const inlineCommand = readInlineFormatCommand(command);
        if (inlineCommand !== "link" && pendingInlineFormats.has(inlineCommand)) {
            return true;
        }
        const from = Math.min(state.selection.anchor, state.selection.head);
        const to = Math.max(state.selection.anchor, state.selection.head);
        return Array.from(document.querySelectorAll<HTMLElement>(".markdown-token[data-markdown-token-kind]"))
            .some((token) => {
                const range = readSourceTokenDocumentRange(token);
                if (!range || (from === to ? from < range.from || from > range.to : from < range.from || to > range.to)) {
                    return false;
                }
                if (
                    from === to &&
                    (from === range.from && state.selection.headAffinity === "upstream" ||
                        from === range.to && state.selection.headAffinity !== "upstream")
                ) {
                    return false;
                }
                const kind = token.dataset.markdownTokenKind;
                if (command === "bold") return kind === "strong" || kind === "strong-emphasis";
                if (command === "italic") return kind === "emphasis" || kind === "strong-emphasis";
                if (command === "strike") return kind === "formatting" && token.dataset.sourceRaw?.startsWith("~~") === true;
                if (command === "inline-code") return kind === "code";
                return kind === "link" || kind === "autolink" || kind === "url";
            });
    }

    function handleEditorCompositionEnd(event: CompositionEvent): void {
        isComposingText = false;
        setCompositionSurface(null);
        const insert = event.data ?? "";
        const lease = compositionLease;
        compositionLease = null;
        if (!lease || lease.sessionId !== documentState.sessionId || lease.revision !== getDocumentRevision()) {
            reconcileCompositionDom();
            syncDomSelectionFromState({ focus: "preserve" });
            return;
        }
        if (insert) {
            const state = getEditorState();
            const transaction = createSourceInsertTextTransaction(
                { ...state, selection: preCompositionSourceSelection },
                prepareVirtualEofInsertion(insert, preCompositionSourceSelection),
            );
            transaction.annotations = { ...transaction.annotations, historyMode: "discrete" };
            reconcileCompositionDom();
            dispatch(transaction);
        } else {
            reconcileCompositionDom();
            syncDomSelectionFromState({ focus: "preserve" });
        }
    }

    function reconcileCompositionDom(): void {
        getEditorBlocks().forEach(invalidateBlockRenderCache);
        replaceEditorBlocksFromSourceState(getEditorState());
    }

    function cancelComposition(): void {
        if (!compositionLease && !isComposingText) return;
        compositionLease = null;
        isComposingText = false;
        setCompositionSurface(null);
        reconcileCompositionDom();
        syncDomSelectionFromState({ focus: "preserve" });
    }

    function handleEditorPaste(event: ClipboardEvent): void {
        handleSourcePaste(event);
    }

    function handleEditorCopy(event: ClipboardEvent): void {
        handleSourceCopy(event);
    }

    function handleEditorCut(event: ClipboardEvent): void {
        handleSourceCut(event);
    }

    function handleEditorDragOver(event: DragEvent): void {
        if (event.dataTransfer?.types.includes("text/plain") || readClipboardImages(event.dataTransfer).length > 0) {
            event.preventDefault();
            if (event.dataTransfer && internalDrag) {
                event.dataTransfer.dropEffect = event.ctrlKey || event.altKey ? "copy" : "move";
            }
        }
    }

    function handleEditorDragStart(event: DragEvent): void {
        syncStateSelectionFromDom();
        const state = getEditorState();
        const selection = readClipboardSelection(state) ?? state.selection;
        const from = Math.min(selection.anchor, selection.head);
        const to = Math.max(selection.anchor, selection.head);
        if (!event.dataTransfer || from === to) {
            internalDrag = null;
            return;
        }

        const source = state.doc.slice(from, to);
        internalDrag = {
            sessionId: documentState.sessionId,
            revision: state.revision,
            from,
            to,
            source,
        };
        const payload = createClipboardPayload();
        event.dataTransfer.effectAllowed = "copyMove";
        event.dataTransfer.setData("text/markdown", payload.markdown);
        event.dataTransfer.setData("text/plain", payload.plainText);
    }

    function handleEditorDragEnd(): void {
        internalDrag = null;
    }

    function handleEditorDrop(event: DragEvent): void {
        handleSourceDrop(event);
    }

    function handleEditorClick(event: MouseEvent): void {
        const target = event.target as Element | null;
        if (
            event.shiftKey &&
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            target &&
            !target.closest("button, input, textarea, select") &&
            findBlock(target)
        ) {
            event.preventDefault();
            return;
        }
        const tableCell = target?.closest<HTMLTableCellElement>(".markdown-table th, .markdown-table td");
        if (tableCell) {
            event.preventDefault();
            if (event.detail > 1) {
                return;
            }
            if (!tableCellController.isEditing(tableCell)) {
                tableCellController.start(tableCell);
            }
            return;
        }

        const imageToken = target?.closest<HTMLElement>(".markdown-image-token");
        if (imageToken) {
            event.preventDefault();
            return;
        }

        const mathToken = target?.closest<HTMLElement>(".markdown-math-token");
        if (mathToken) {
            event.preventDefault();
            return;
        }

        const preview = target?.closest<HTMLElement>(".format-block-preview");
        const previewBlock = preview ? findBlock(preview) : null;
        const previewType = previewBlock?.dataset.type;
        if (
            preview &&
            previewBlock &&
            (previewType === "table" || previewType === "math" || previewType === "html" || previewType === "definition-list")
        ) {
            event.preventDefault();
            editBlockObjectSource(previewBlock);
            return;
        }

        const link = target?.closest<HTMLAnchorElement>("a[href]");
        if (!link) {
            return;
        }
        event.preventDefault();
        if (!(event.ctrlKey || event.metaKey || event.detail === 0)) {
            return;
        }
        const href = link.dataset.href ?? link.getAttribute("href") ?? "";
        if (href.startsWith("#")) {
            document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ block: "center" });
            return;
        }
        if (/^https?:|^mailto:/i.test(href)) {
            window.open(href, "_blank", "noopener,noreferrer");
        }
    }

    function editInlineObjectSource(token: HTMLElement): void {
        clearInlineObjectSelection();
        const range = readSourceTokenDocumentRange(token);
        if (!range || !activateSourceToken(token, 1)) {
            return;
        }

        const head = Math.min(range.to, range.from + 1);
        dispatch({
            changes: [],
            selection: {
                anchor: head,
                head,
                source: true,
            },
            annotations: { userEvent: "programmatic", addToHistory: false },
        });
        syncDomSelectionFromState({ focus: "editor", scrollIntoView: true });
    }

    function selectInlineObject(token: HTMLElement): void {
        clearInlineObjectSelection();
        const range = readSourceTokenDocumentRange(token);
        if (!range) return;

        token.dataset.objectSelected = "true";
        token.setAttribute("aria-selected", "true");
        const toolbar = document.createElement("div");
        toolbar.className = "inline-object-toolbar";
        toolbar.contentEditable = "false";
        toolbar.setAttribute("role", "toolbar");
        toolbar.setAttribute("aria-label", token.classList.contains("markdown-image-token") ? "Image controls" : "Math controls");
        const label = document.createElement("span");
        label.textContent = token.classList.contains("markdown-image-token") ? "Image" : "Math";
        const edit = document.createElement("button");
        edit.type = "button";
        edit.textContent = "Edit Markdown";
        edit.addEventListener("pointerdown", (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        edit.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            editInlineObjectSource(token);
        });
        toolbar.append(label, edit);
        document.body.append(toolbar);
        positionInlineObjectToolbar(toolbar, token);
        activeInlineObject = { token, toolbar, from: range.from, to: range.to };
        dispatch({
            changes: [],
            selection: { anchor: range.to, head: range.to, anchorAffinity: "upstream", headAffinity: "upstream" },
            annotations: { userEvent: "programmatic", addToHistory: false },
        });
        document.getElementById("editor")?.focus({ preventScroll: true });
    }

    function positionInlineObjectToolbar(toolbar: HTMLElement, token: HTMLElement): void {
        const rect = token.getBoundingClientRect();
        toolbar.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 190))}px`;
        toolbar.style.top = `${Math.max(8, rect.top - 42)}px`;
    }

    function clearInlineObjectSelection(): void {
        const active = activeInlineObject;
        if (!active) return;
        delete active.token.dataset.objectSelected;
        active.token.removeAttribute("aria-selected");
        active.toolbar.remove();
        activeInlineObject = null;
    }

    function editBlockObjectSource(block: HTMLElement, selectAll = false): void {
        const from = Number.parseInt(block.dataset.sourceFrom ?? "", 10);
        const to = Number.parseInt(block.dataset.sourceTo ?? "", 10);
        if (!Number.isFinite(from) || !Number.isFinite(to)) return;
        dispatch({
            changes: [],
            selection: selectAll
                ? {
                    anchor: from,
                    head: to,
                    source: true,
                }
                : {
                    anchor: from,
                    head: from,
                    source: true,
                },
            annotations: { userEvent: "programmatic", addToHistory: false },
        });
        syncDomSelectionFromState({ focus: "editor", scrollIntoView: true });
    }

    function handleSourceKeydown(event: KeyboardEvent): boolean {
        if (isComposingText || event.isComposing || event.keyCode === 229) {
            return true;
        }

        if (activeInlineObject) {
            if (event.key === "Escape") {
                event.preventDefault();
                clearInlineObjectSelection();
                return true;
            }
            if (event.key === "Enter") {
                event.preventDefault();
                editInlineObjectSource(activeInlineObject.token);
                return true;
            }
            if (event.key === "Backspace" || event.key === "Delete") {
                event.preventDefault();
                const { from, to } = activeInlineObject;
                clearInlineObjectSelection();
                dispatch({
                    changes: [{ from, to, insert: "" }],
                    selection: { anchor: from, head: from },
                    annotations: { userEvent: "delete", historyMode: "discrete" },
                });
                syncDomSelectionFromState({ focus: "editor", scrollIntoView: true });
                return true;
            }
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                const target = event.key === "ArrowLeft" ? activeInlineObject.from : activeInlineObject.to;
                clearInlineObjectSelection();
                dispatch({
                    changes: [],
                    selection: { anchor: target, head: target },
                    annotations: { userEvent: "programmatic", addToHistory: false },
                });
                syncDomSelectionFromState({ focus: "editor", scrollIntoView: true });
                return true;
            }
        }

        // Let beforeinput own source-first range edits. Handling the same
        // deletion on keydown would race selection projection and duplicate the
        // transaction.
        if (
            getEditorState().selection.anchor !== getEditorState().selection.head &&
            (isPlainTextKeydown(event) || event.key === "Backspace" || event.key === "Delete")
        ) {
            return true;
        }

        if (matchesShortcutCommand(event, "edit:select-all", "markdown")) {
            event.preventDefault();
            void executeCommand("select-all");
            return true;
        }

        const inlineFormat = readInlineFormatShortcut(event, "markdown");
        if (inlineFormat) {
            event.preventDefault();
            void executeCommand(inlineFormat);
            return true;
        }

        if (event.key === "Enter") {
            event.preventDefault();
            syncStateSelectionFromDom();
            const state = getEditorState();
            dispatch(
                (!options.isSourceMode()
                    ? options.getActiveDocumentFormat().editing?.createEnterTransaction?.(state, { shiftKey: event.shiftKey })
                    : null)
                ?? createSourceInsertTextTransaction(state, "\n"),
            );
            syncDomSelectionFromState({ scrollIntoView: true });
            return true;
        }

        if (event.key === "Tab") {
            syncStateSelectionFromDom();
            const state = getEditorState();
            const transaction = options.isSourceMode()
                ? null
                : options.getActiveDocumentFormat().editing?.createTabTransaction?.(
                    state,
                    event.shiftKey ? -1 : 1,
                ) ?? null;
            if (!transaction) {
                const block = state.blocks.blocks.find((candidate) => (
                    state.selection.head >= candidate.contentFrom && state.selection.head <= candidate.contentTo
                ));
                if (block?.type !== "source") {
                    return false;
                }
                event.preventDefault();
                dispatch(createIndentSourceTransaction(state, event.shiftKey));
                syncDomSelectionFromState({ scrollIntoView: true });
                return true;
            }

            event.preventDefault();
            dispatch(transaction);
            syncDomSelectionFromState({ scrollIntoView: true });
            return true;
        }

        if (event.key === "Backspace" || event.key === "Delete") {
            event.preventDefault();
            syncStateSelectionFromDom();
            const transaction = createSourceDeleteTransaction(
                getEditorState(),
                event.key === "Backspace" ? "backward" : "forward",
                readDeleteGranularityFromKeydown(event),
            );
            if (transaction) {
                dispatch(transaction);
                if (transaction.changes.length === 0) {
                    syncDomSelectionFromState({ focus: "editor", scrollIntoView: true });
                }
            }
            return true;
        }

        if (event.key === "Escape" && pendingInlineFormats.size > 0) {
            event.preventDefault();
            clearPendingInlineFormats();
            return true;
        }

        if (event.key === "Escape") {
            const selection = getEditorState().selection;
            const token = Array.from(document.querySelectorAll<HTMLElement>(".markdown-token-editing"))
                .reverse().find(candidate => {
                    const owned = readSourceTokenDocumentRange(candidate);
                    return candidate.dataset.sourcePinned !== "true" && owned && selection.head >= owned.from && selection.head <= owned.to;
                });
            const range = token ? readSourceTokenDocumentRange(token) : null;
            if (range) {
                event.preventDefault();
                clearInlineTypingSourceReveal();
                clearSourceReveal();
                dispatch({
                    changes: [],
                    selection: {
                        anchor: selection.anchor === selection.head ? range.to : selection.head,
                        head: selection.anchor === selection.head ? range.to : selection.head,
                        anchorAffinity: "upstream",
                        headAffinity: "upstream",
                    },
                    annotations: { userEvent: "programmatic", addToHistory: false },
                });
                syncDomSelectionFromState({ focus: "editor", scrollIntoView: true });
                return true;
            }
        }

        if (
            pendingInlineFormats.size > 0 &&
            ["Enter", "Tab", "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
        ) {
            clearPendingInlineFormats();
        }
        if (["Escape", "Enter", "Tab", "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
            clearInlineTypingSourceReveal();
        }

        if (handleSourceHorizontalNavigation(event)) {
            return true;
        }

        if (isSourceVerticalNavigationKey(event)) {
            syncStateSelectionFromDom();
            if (moveSourceSelectionVertically(
                event.key === "ArrowUp" ? "up" : "down",
                { extend: event.shiftKey },
            )) {
                event.preventDefault();
                return true;
            }
            return false;
        }

        return false;
    }

    function handleSourceHorizontalNavigation(event: KeyboardEvent): boolean {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || event.metaKey && !["Home", "End"].includes(event.key)) {
            return false;
        }

        event.preventDefault();
        syncStateSelectionFromDom();
        const state = getEditorState();
        const currentHead = state.selection.head;
        const backward = event.key === "ArrowLeft" || event.key === "Home";
        let target: number;

        if (!event.shiftKey && state.selection.anchor !== state.selection.head && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
            target = backward
                ? Math.min(state.selection.anchor, state.selection.head)
                : Math.max(state.selection.anchor, state.selection.head);
        } else if (event.key === "Home") {
            target = event.ctrlKey || event.metaKey ? 0 : readVisualLineBoundary("backward") ?? previousLineBoundary(state.doc, currentHead);
        } else if (event.key === "End") {
            target = event.ctrlKey || event.metaKey ? state.doc.length : readVisualLineBoundary("forward") ?? nextLineBoundary(state.doc, currentHead);
        } else if (event.ctrlKey || event.altKey) {
            target = backward
                ? previousWordBoundary(state.doc, currentHead)
                : nextWordBoundary(state.doc, currentHead);
        } else {
            target = backward
                ? previousGraphemeBoundary(state.doc, currentHead)
                : nextGraphemeBoundary(state.doc, currentHead);
        }

        target = resolveVisibleSourceOffset(state.blocks, target, backward ? "backward" : "forward");
        const defaultAffinity = event.key === "End" || event.key === "ArrowLeft" ? "upstream" as const : "downstream" as const;
        const affinity = event.key === "ArrowLeft"
            ? resolveListNavigationAffinity(state, target, defaultAffinity)
            : defaultAffinity;
        const extendedAnchor = state.selection.anchor === state.selection.head
            ? currentHead
            : state.selection.anchor;

        const nextSelection = {
            anchor: event.shiftKey ? extendedAnchor : target,
            head: target,
            anchorAffinity: event.shiftKey ? state.selection.anchorAffinity : affinity,
            headAffinity: affinity,
        };
        dispatch({
            changes: [],
            selection: {
                ...nextSelection,
                source: selectionTouchesSource(nextSelection),
            },
            annotations: { userEvent: "programmatic", addToHistory: false },
        });
        syncDomSelectionFromState({ focus: "editor", scrollIntoView: true });
        return true;
    }

    function handleSourceBeforeInput(event: InputEvent): boolean {
        if (isComposingText) {
            return true;
        }

        const transaction = readSourceBeforeInputTransaction(event);
        if (!transaction) {
            if (/^(?:insert|delete|format)/.test(event.inputType)) {
                event.preventDefault();
                console.warn(`Cancelled unsupported beforeinput operation: ${event.inputType}`);
                syncDomSelectionFromState({ scrollIntoView: true });
                reportEditorError("An unsupported editing operation was safely cancelled.");
                return true;
            }
            return false;
        }

        event.preventDefault();
        syncStateSelectionFromDom();
        const nextTransaction = transaction();
        if (nextTransaction) {
            dispatch(nextTransaction);
            if (nextTransaction.changes.length === 0) {
                syncDomSelectionFromState({ focus: "editor", scrollIntoView: true });
            }
        }
        return true;
    }

    function readSourceBeforeInputTransaction(event: InputEvent): (() => Parameters<typeof dispatch>[0] | null) | null {
        if (event.inputType === "insertReplacementText") {
            const text = event.data ?? event.dataTransfer?.getData("text/plain");
            const targets = event.getTargetRanges?.() ?? [];
            const target = targets[0];
            const editor = document.getElementById("editor");
            const sessionId = documentState.sessionId;
            const revision = getDocumentRevision();
            if (text === undefined || targets.length > 1 || target && (!editor?.contains(target.startContainer) || !editor.contains(target.endContainer))) return () => null;
            const selection = target ? {
                anchor: domPointToSourceOffset(target.startContainer, target.startOffset),
                head: domPointToSourceOffset(target.endContainer, target.endOffset),
                source: true,
            } : null;
            return () => {
                if (sessionId !== documentState.sessionId || revision !== getDocumentRevision()) return null;
                clearPendingInlineFormats();
                const state = getEditorState();
                const transaction = createInsertTextTransaction({ ...state, selection: selection ?? state.selection }, text);
                transaction.annotations = { userEvent: "input", historyMode: "discrete" };
                return transaction;
            };
        }
        if (
            event.inputType === "insertText" &&
            event.data !== null
        ) {
            return () => {
                const state = getEditorState();
                const wrappedSelection = supportsRichSourceEditing()
                    ? createSelectedTextWrapperTransaction(state, event.data ?? "")
                    : null;
                if (wrappedSelection) {
                    clearPendingInlineFormats();
                    return wrappedSelection;
                }
                const text = prepareVirtualEofInsertion(event.data ?? "", state.selection);
                const pending = pendingInlineFormats.size > 0
                    ? createPendingInlineFormatInsertTransaction(state, text, Array.from(pendingInlineFormats))
                    : null;
                if (pendingInlineFormats.size > 0) {
                    clearPendingInlineFormats();
                }
                return pending ?? createSourceInsertTextTransaction(state, text);
            };
        }

        // Chromium emits these before the corresponding clipboard/drag event.
        // Those handlers own source serialization and transactions, so suppress
        // the browser DOM mutation here without reporting an unsupported action.
        if (
            event.inputType === "deleteByCut" ||
            event.inputType === "deleteByDrag" ||
            event.inputType === "insertFromPaste" ||
            event.inputType === "insertFromDrop"
        ) {
            return () => null;
        }

        if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") {
            return () => {
                const state = getEditorState();
                return (!options.isSourceMode()
                    ? options.getActiveDocumentFormat().editing?.createEnterTransaction?.(state, { shiftKey: event.inputType === "insertLineBreak" })
                    : null)
                    ?? createSourceInsertTextTransaction(state, "\n");
            };
        }

        if (event.inputType === "deleteContentBackward") {
            return () => createSourceDeleteTransaction(getEditorState(), "backward", "grapheme");
        }

        if (event.inputType === "deleteContentForward") {
            return () => createSourceDeleteTransaction(getEditorState(), "forward", "grapheme");
        }

        if (event.inputType === "deleteWordBackward") {
            return () => createSourceDeleteTransaction(getEditorState(), "backward", "word");
        }

        if (event.inputType === "deleteWordForward") {
            return () => createSourceDeleteTransaction(getEditorState(), "forward", "word");
        }

        if (event.inputType === "deleteSoftLineBackward" || event.inputType === "deleteHardLineBackward") {
            return () => createSourceDeleteTransaction(
                getEditorState(),
                "backward",
                event.inputType === "deleteSoftLineBackward" ? "soft-line" : "hard-line",
            );
        }

        if (event.inputType === "deleteSoftLineForward" || event.inputType === "deleteHardLineForward") {
            return () => createSourceDeleteTransaction(
                getEditorState(),
                "forward",
                event.inputType === "deleteSoftLineForward" ? "soft-line" : "hard-line",
            );
        }

        if (event.inputType === "deleteEntireSoftLine") {
            return () => createDeleteEntireLineTransaction();
        }

        return null;
    }

    function createDeleteEntireLineTransaction(): Parameters<typeof dispatch>[0] | null {
        const state = getEditorState();
        const head = state.selection.head;
        const lineFrom = state.doc.lastIndexOf("\n", Math.max(0, head - 1)) + 1;
        const nextBreak = state.doc.indexOf("\n", head);
        const lineTo = nextBreak < 0 ? state.doc.length : Math.min(state.doc.length, nextBreak + 1);
        if (lineFrom === lineTo) {
            return null;
        }
        return {
            changes: [{ from: lineFrom, to: lineTo, insert: "" }],
            selection: { anchor: lineFrom, head: lineFrom },
            annotations: { userEvent: "delete", historyMode: "typing" },
        };
    }

    function handleSourceCopy(event: ClipboardEvent): boolean {
        syncSourceSelectionForCommand();
        const state = getEditorState();
        const clipboardSelection = readClipboardSelection(state);
        if (clipboardSelection === null || !event.clipboardData) {
            return preventUnmappedSourceClipboardDefault(event);
        }

        event.preventDefault();
        if (!writeSourceClipboard(event.clipboardData)) {
            syncDomSelectionFromState({ scrollIntoView: true });
        }
        return true;
    }

    function handleSourceCut(event: ClipboardEvent): boolean {
        syncSourceSelectionForCommand();
        const state = getEditorState();
        const clipboardSelection = readClipboardSelection(state);
        const transaction = clipboardSelection
            ? createSourceDeleteTransaction(
                { ...state, selection: clipboardSelection },
                "forward",
                "grapheme",
            )
            : null;
        if (clipboardSelection === null || !transaction || !event.clipboardData) {
            return preventUnmappedSourceClipboardDefault(event);
        }

        event.preventDefault();
        if (!writeSourceClipboard(event.clipboardData)) {
            syncDomSelectionFromState({ scrollIntoView: true });
            return true;
        }
        dispatch(transaction);
        return true;
    }

    function preventUnmappedSourceClipboardDefault(event: ClipboardEvent): boolean {
        const selection = document.getSelection();
        const editor = document.getElementById("editor");
        const hasEditorRange = Boolean(
            selection &&
            !selection.isCollapsed &&
            editor &&
            selection.anchorNode &&
            selection.focusNode &&
            editor.contains(selection.anchorNode) &&
            editor.contains(selection.focusNode),
        );
        if (!hasEditorRange) {
            return false;
        }

        event.preventDefault();
        syncDomSelectionFromState({ scrollIntoView: true });
        return true;
    }

    function handleSourcePaste(event: ClipboardEvent): boolean {
        const result = supportsRichSourceEditing()
            ? options.getActiveDocumentFormat().clipboard?.read?.(event.clipboardData) ?? null
            : event.clipboardData?.types.includes("text/plain")
                ? { kind: "plain", value: event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n") } as ClipboardReadResult
                : null;
        const images = supportsRichSourceEditing() ? readClipboardImages(event.clipboardData) : [];
        if (shouldPreferClipboardImages(images, result, event.clipboardData)) {
            event.preventDefault();
            syncStateSelectionFromDom();
            void pasteSourceImages(images, createSelectionBookmark());
            return true;
        }
        if (result) {
            event.preventDefault();
            if ("warning" in result && result.warning) {
                reportEditorError(result.warning);
            }
            if (result.kind === "images") {
                syncStateSelectionFromDom();
                void pasteSourceImages(result.files, createSelectionBookmark());
            } else if (result.kind === "html" && containsDataImage(result.value)) {
                syncStateSelectionFromDom();
                void pasteHtmlWithDataImages(result.value, createSelectionBookmark());
            } else if (result.value !== "") {
                pasteSourceText(result.value);
            }
            return true;
        }

        if (images.length === 0) {
            return false;
        }
        event.preventDefault();
        syncStateSelectionFromDom();
        void pasteSourceImages(images, createSelectionBookmark());
        return true;
    }

    async function pasteHtmlWithDataImages(
        markdown: string,
        bookmark: ReturnType<typeof createSelectionBookmark>,
    ): Promise<void> {
        const sessionId = documentState.sessionId;
        try {
            const converted = convertDataImagesToFiles(markdown);
            const staged = stagePendingImages(converted.files);
            let source = markdown;
            for (let index = 0; index < converted.urls.length; index += 1) {
                const replacement = staged.sources.find((candidate) => candidate.inputIndex === index)?.source ?? "";
                source = source.split(converted.urls[index]).join(replacement);
            }
            if (staged.rejected.length > 0) {
                reportEditorError(staged.rejected[0]);
            }

            const selection = bookmark.read();
            if (selection && sessionId === documentState.sessionId && source !== "") {
                const state = getEditorState();
                dispatch(createSourcePasteTransaction(
                    { ...state, selection },
                    prepareVirtualEofInsertion(source, selection),
                ));
            }
        } catch (error) {
            console.error("Failed to import pasted data images:", error);
            reportEditorError("One or more pasted images could not be imported.");
        } finally {
            pruneUnreferencedPendingImages();
            bookmark.dispose();
        }
    }

    function handleSourceDrop(event: DragEvent): boolean {
        const text = readDroppedText(event.dataTransfer);
        const images = supportsRichSourceEditing() ? readClipboardImages(event.dataTransfer) : [];
        if (!text && images.length === 0) {
            return false;
        }

        event.preventDefault();
        syncSourceSelectionFromDropPoint(event);
        if (images.length > 0) {
            void pasteSourceImages(images, createSelectionBookmark());
        } else if (text) {
            const state = getEditorState();
            const target = state.selection.head;
            const drag = internalDrag;
            const move = drag &&
                drag.sessionId === documentState.sessionId &&
                drag.revision <= state.revision &&
                drag.source === text &&
                event.dataTransfer?.dropEffect === "move";
            if (move && drag) {
                applyInternalDragMove(drag, target);
            } else {
                dispatch(createSourcePasteTransaction(state, text));
            }
            internalDrag = null;
        }

        return true;
    }

    function applyInternalDragMove(
        drag: NonNullable<typeof internalDrag>,
        target: number,
    ): void {
        const state = getEditorState();
        if (
            (target >= drag.from && target <= drag.to) ||
            state.doc.slice(drag.from, drag.to) !== drag.source
        ) {
            return;
        }

        const sourceLength = drag.to - drag.from;
        const finalFrom = target > drag.to ? target - sourceLength : target;
        dispatch({
            changes: [
                { from: drag.from, to: drag.to, insert: "" },
                { from: target, to: target, insert: drag.source },
            ],
            selection: { anchor: finalFrom, head: finalFrom + drag.source.length },
            annotations: { userEvent: "input", historyMode: "discrete" },
        });
    }

    async function pasteSourceImages(
        images: File[],
        bookmark: ReturnType<typeof createSelectionBookmark>,
    ): Promise<void> {
        const lease = {
            sessionId: documentState.sessionId,
            formatId: options.getActiveDocumentFormat().descriptor.id,
            path: options.getActiveFilePath(),
            focusOwner: document.activeElement,
        };
        try {
            const selection = bookmark.read();
            if (!selection || lease.formatId !== "markdown" || images.length === 0) {
                return;
            }

            let sources: string[] = [];
            if (!lease.path) {
                const staged = stagePendingImages(images);
                sources = staged.sources.map(({ source, file }) => (
                    options.getActiveDocumentFormat().editing?.createPastedImageSource?.(source, file.name) ?? ""
                )).filter(Boolean);
                if (staged.rejected.length > 0) {
                    reportEditorError(staged.rejected[0]);
                }
            } else {
                const persisted = await persistImageFiles(lease.path, images, lease.sessionId);
                if (
                    lease.sessionId !== documentState.sessionId ||
                    lease.formatId !== options.getActiveDocumentFormat().descriptor.id ||
                    lease.path !== options.getActiveFilePath()
                ) {
                    reportEditorError("Image paste was cancelled because the document changed.");
                    return;
                }
                sources = persisted.map(({ relativePath, file }) => (
                    options.getActiveDocumentFormat().editing?.createPastedImageSource?.(relativePath, file.name) ?? ""
                )).filter(Boolean);
            }

            const mappedSelection = bookmark.read();
            if (sources.length > 0 && mappedSelection && lease.sessionId === documentState.sessionId) {
                const state = getEditorState();
                dispatch(createSourcePasteTransaction(
                    { ...state, selection: mappedSelection },
                    sources.join(" "),
                ));
                if (lease.focusOwner && document.activeElement === lease.focusOwner) {
                    syncDomSelectionFromState({ focus: "editor", scrollIntoView: true });
                }
            }
        } catch (error) {
            console.error("Failed to paste image:", error);
            reportEditorError(error instanceof Error ? error.message : "Could not save the pasted image.");
        } finally {
            pruneUnreferencedPendingImages();
            bookmark.dispose();
        }
    }

    function pasteSourceText(text: string): void {
        syncStateSelectionFromDom();
        const state = getEditorState();
        dispatch(createSourcePasteTransaction(state, prepareVirtualEofInsertion(text, state.selection)));
    }

    function prepareVirtualEofInsertion(
        text: string,
        selection: ReturnType<typeof getEditorState>["selection"],
    ): string {
        const editor = document.getElementById("editor");
        const state = getEditorState();
        if (
            editor?.dataset.virtualEofCaret !== "true" ||
            selection.anchor !== selection.head ||
            selection.head !== state.doc.length
        ) {
            return text;
        }

        editor.dataset.virtualEofCaret = "false";
        if (state.doc === "" || state.doc.endsWith("\n\n")) {
            return text;
        }
        return `${state.doc.endsWith("\n") ? "\n" : "\n\n"}${text}`;
    }

    function syncSourceSelectionFromDropPoint(event: DragEvent): void {
        const caretPosition = getCaretPositionFromPoint(event.clientX, event.clientY);
        if (!caretPosition) {
            syncStateSelectionFromDom();
            return;
        }

        const offset = domPointToSourceOffset(caretPosition.node, caretPosition.offset);
        dispatch({
            changes: [],
            selection: { anchor: offset, head: offset },
            annotations: { userEvent: "programmatic", addToHistory: false },
        });
    }

    function supportsRichSourceEditing(): boolean {
        if (options.isSourceMode()) {
            return false;
        }
        const format = options.getActiveDocumentFormat();
        return Boolean(format.clipboard?.richHtml && format.clipboard.mimeTypes.includes("text/markdown"));
    }

    function canUsePendingInlineFormat(state: ReturnType<typeof getEditorState>): boolean {
        const block = findSourceBlockAtOffset(state.blocks, state.selection.head);
        return Boolean(block && [
            "paragraph",
            "heading-1",
            "heading-2",
            "heading-3",
            "heading-4",
            "heading-5",
            "heading-6",
            "list",
            "ordered-list",
            "todo",
            "quote",
        ].includes(block.type));
    }

    function togglePendingInlineFormat(
        command: Exclude<InlineFormatCommand, "link">,
        offset: number,
    ): void {
        if (command === "code") {
            const wasActive = pendingInlineFormats.has(command);
            pendingInlineFormats.clear();
            if (!wasActive) pendingInlineFormats.add(command);
        } else {
            pendingInlineFormats.delete("code");
            if (pendingInlineFormats.has(command)) pendingInlineFormats.delete(command);
            else pendingInlineFormats.add(command);
        }
        pendingInlineFormatOffset = pendingInlineFormats.size > 0 ? offset : null;
        options.syncActiveBlockIndicator(findBlock(document.getSelection()?.focusNode ?? null));
    }

    function clearPendingInlineFormats(): void {
        pendingInlineFormats.clear();
        pendingInlineFormatOffset = null;
    }

    function handleEditorSelectionChange(): void {
        const state = getEditorState();
        if (pendingInlineFormatOffset !== null && (
            state.selection.anchor !== state.selection.head ||
            state.selection.head !== pendingInlineFormatOffset
        )) {
            clearPendingInlineFormats();
        }
    }

    function createSourceInsertTextTransaction(
        state: ReturnType<typeof getEditorState>,
        text: string,
    ): Parameters<typeof dispatch>[0] {
        const transaction = (!options.isSourceMode()
            ? options.getActiveDocumentFormat().editing?.createInsertTextTransaction?.(state, text)
            : null)
            ?? createInsertTextTransaction(state, text);
        return preserveSourceSelection(state, transaction);
    }

    function createSourcePasteTransaction(
        state: ReturnType<typeof getEditorState>,
        text: string,
    ): Parameters<typeof dispatch>[0] {
        const transaction = (!options.isSourceMode()
            ? options.getActiveDocumentFormat().editing?.createPasteTransaction?.(state, text)
            : null)
            ?? createPasteTransaction(state, text);
        return preserveSourceSelection(state, transaction);
    }

    function createSourceDeleteTransaction(
        state: ReturnType<typeof getEditorState>,
        direction: "backward" | "forward",
        granularity: "grapheme" | "word" | "soft-line" | "hard-line",
    ): Parameters<typeof dispatch>[0] | null {
        const transaction = (!options.isSourceMode()
            ? options.getActiveDocumentFormat().editing?.createDeleteTransaction?.(state, direction, granularity)
            : null)
            ?? createDeleteTransaction(state, direction, granularity);
        return transaction ? preserveSourceSelection(state, transaction) : null;
    }

    function preserveSourceSelection(
        state: ReturnType<typeof getEditorState>,
        transaction: Parameters<typeof dispatch>[0],
    ): Parameters<typeof dispatch>[0] {
        if (!isSourceSelection(state.selection) || !transaction.selection || transaction.selection.source !== undefined) {
            return transaction;
        }
        return {
            ...transaction,
            selection: { ...transaction.selection, source: true },
        };
    }

    function writeSourceClipboard(clipboard: DataTransfer): boolean {
        try {
            if (supportsRichSourceEditing()) {
                const write = options.getActiveDocumentFormat().clipboard?.write;
                if (!write) {
                    return false;
                }
                write(clipboard, createClipboardPayload());
            } else {
                const state = getEditorState();
                const selection = readClipboardSelection(state);
                clipboard.setData(
                    "text/plain",
                    selection ? state.doc.slice(selection.anchor, selection.head) : "",
                );
            }
            return true;
        } catch (error) {
            console.error("Failed to populate the source clipboard:", error);
            return false;
        }
    }

    function isSourceVerticalNavigationKey(event: KeyboardEvent): boolean {
        return (
            (event.key === "ArrowUp" || event.key === "ArrowDown") &&
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey
        );
    }

    function createClipboardPayload(): ClipboardPayload {
        const context = createClipboardSelectionContext();
        return supportsRichSourceEditing()
            ? options.getActiveDocumentFormat().clipboard?.createPayload?.(context)
                ?? createPlainClipboardPayload(context.state.doc.slice(context.from, context.to))
            : createPlainClipboardPayload(context.state.doc.slice(context.from, context.to));
    }

    function createClipboardSelectionContext(): ClipboardSelectionContext {
        const state = getEditorState();
        const selection = readClipboardSelection(state) ?? state.selection;
        const from = Math.min(selection.anchor, selection.head);
        const to = Math.max(selection.anchor, selection.head);
        return {
            state,
            from,
            to,
            blocks: state.blocks.blocks.filter((block) => from < block.sourceTo && to > block.sourceFrom),
            activeFilePath: options.getActiveFilePath(),
        };
    }

    function readClipboardSelection(state: ReturnType<typeof getEditorState>): { anchor: number; head: number } | null {
        const from = Math.min(state.selection.anchor, state.selection.head);
        const to = Math.max(state.selection.anchor, state.selection.head);
        if (from === to) {
            return null;
        }
        const resolved = supportsRichSourceEditing()
            ? options.getActiveDocumentFormat().clipboard?.resolveSelectionRange?.(state)
            : null;
        return resolved
            ? { anchor: resolved.from, head: resolved.to }
            : { anchor: from, head: to };
    }

    function createPlainClipboardPayload(text: string): ClipboardPayload {
        return { markdown: text, plainText: text, html: escapeClipboardText(text) };
    }

    function readDeleteGranularityFromKeydown(event: KeyboardEvent): "grapheme" | "word" | "hard-line" {
        if (event.metaKey) {
            return "hard-line";
        }
        if (event.ctrlKey || event.altKey) {
            return "word";
        }
        return "grapheme";
    }

    function readDroppedText(dataTransfer: DataTransfer | null): string {
        if (!dataTransfer) {
            return "";
        }
        if (supportsRichSourceEditing()) {
            return dataTransfer.getData("text/markdown") || dataTransfer.getData("text/plain");
        }
        return dataTransfer.getData("text/plain");
    }
}

function shouldPreferClipboardImages(
    images: File[],
    result: ClipboardReadResult | null,
    dataTransfer: DataTransfer | null | undefined,
): boolean {
    if (images.length === 0) {
        return false;
    }
    if (!result || result.kind === "plain") {
        return true;
    }
    if (result.kind !== "html") {
        return false;
    }
    return !hasMeaningfulNonImageClipboardHtml(dataTransfer?.getData("text/html") ?? "");
}

function isTextEntryElement(element: Element | null): element is HTMLInputElement | HTMLTextAreaElement {
    if (element instanceof HTMLTextAreaElement) {
        return true;
    }
    if (!(element instanceof HTMLInputElement)) {
        return false;
    }
    return ["text", "search", "tel", "url", "password"].includes(element.type);
}

function containsDataImage(value: string): boolean {
    return /data:image\/(?:gif|jpe?g|png|webp);base64,/i.test(value);
}

function convertDataImagesToFiles(markdown: string): { urls: string[]; files: File[] } {
    const urls = Array.from(new Set(
        markdown.match(/data:image\/(?:gif|jpe?g|png|webp);base64,[A-Za-z0-9+/=]+/gi) ?? [],
    ));
    const files = urls.map((url, index) => {
        const match = url.match(/^data:(image\/(?:gif|jpe?g|png|webp));base64,(.+)$/i);
        if (!match) {
            throw new Error("Unsupported image data URL.");
        }
        const bytes = Uint8Array.from(atob(match[2]), (character) => character.charCodeAt(0));
        const mimeType = match[1].toLowerCase().replace("image/jpg", "image/jpeg");
        return new File(
            [bytes],
            `pasted-image-${index + 1}.${extensionForImageMimeType(mimeType)}`,
            { type: mimeType },
        );
    });
    return { urls, files };
}

function isPlainTextKeydown(event: KeyboardEvent): boolean {
    return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
}

function isInlineFormatCommand(command: EditorCommand): command is "bold" | "italic" | "strike" | "inline-code" | "link" {
    return command === "bold" || command === "italic" || command === "strike" || command === "inline-code" || command === "link";
}

function readInlineFormatCommand(command: "bold" | "italic" | "strike" | "inline-code" | "link"): InlineFormatCommand {
    return command === "inline-code" ? "code" : command;
}

function isTextInputCommand(command: EditorCommand): command is "copy" | "cut" | "paste" | "select-all" {
    return command === "copy" || command === "cut" || command === "paste" || command === "select-all";
}

function createSelectedTextWrapperTransaction(
    state: ReturnType<typeof getEditorState>,
    text: string,
): Parameters<typeof dispatch>[0] | null {
    if (
        text.length !== 1 ||
        isSourceSelection(state.selection)
    ) {
        return null;
    }

    const range = {
        from: Math.min(state.selection.anchor, state.selection.head),
        to: Math.max(state.selection.anchor, state.selection.head),
    };
    if (range.from === range.to) {
        return null;
    }

    const block = findSourceBlockAtOffset(state.blocks, range.from);
    if (
        !block ||
        !isInlineWrappableMarkdownBlock(block.type) ||
        range.to > block.contentTo ||
        /\r?\n/.test(state.doc.slice(range.from, range.to))
    ) {
        return null;
    }

    const pair = readSelectionWrapperPair(text, state.doc.slice(range.from, range.to));
    if (!pair) {
        return null;
    }

    return {
        changes: [{
            from: range.from,
            to: range.to,
            insert: `${pair.open}${state.doc.slice(range.from, range.to)}${pair.close}`,
        }],
        selection: {
            anchor: range.from + pair.open.length,
            head: range.to + pair.open.length,
        },
        annotations: { userEvent: "input", historyMode: "typing", typingBoundary: false },
    };
}

function readSelectionWrapperPair(
    character: string,
    selectedText: string,
): { open: string; close: string } | null {
    if (character === "*") {
        return { open: "*", close: "*" };
    }
    if (character === "_") {
        return { open: "_", close: "_" };
    }
    if (character === "`") {
        const longestRun = Math.max(0, ...Array.from(selectedText.matchAll(/`+/g), (match) => match[0].length));
        const marker = "`".repeat(longestRun + 1);
        const needsPadding = selectedText.startsWith("`") || selectedText.endsWith("`") || (
            selectedText.startsWith(" ") && selectedText.endsWith(" ") && selectedText.trim() !== ""
        );
        const padding = needsPadding ? " " : "";
        return { open: `${marker}${padding}`, close: `${padding}${marker}` };
    }
    if (character === "[") {
        return { open: "[", close: "]" };
    }
    if (character === "(") {
        return { open: "(", close: ")" };
    }
    if (character === "{") {
        return { open: "{", close: "}" };
    }
    if (character === "\"") {
        return { open: "\"", close: "\"" };
    }
    if (character === "'") {
        return { open: "'", close: "'" };
    }
    return null;
}

function isInlineWrappableMarkdownBlock(type: SourceBlock["type"] | undefined): boolean {
    return type === "paragraph" ||
        type === "heading-1" ||
        type === "heading-2" ||
        type === "heading-3" ||
        type === "heading-4" ||
        type === "heading-5" ||
        type === "heading-6" ||
        type === "list" ||
        type === "ordered-list" ||
        type === "todo" ||
        type === "quote";
}
