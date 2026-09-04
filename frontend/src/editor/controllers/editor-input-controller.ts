import { documentState } from "../../documents/document-state";
import { Clipboard } from "@wailsio/runtime";
import {
    isSupportedPastedImage,
    persistImageFiles,
    pruneUnreferencedPendingImages,
    stagePendingImages,
} from "../../formats/markdown/pending-images";
import {
    createPendingInlineFormatInsertTransaction,
    createTableTabTransaction,
} from "../../formats/markdown/commands";
import {
    readMarkdownTableColumnCount,
    readMarkdownTableCellRange,
} from "../../formats/markdown/table";
import {
    matchesShortcutCommand,
    readInlineFormatShortcut,
} from "../../app/keymap";
import type {
    BlockFormatCommand,
    ClipboardPayload,
    ClipboardReadResult,
    ClipboardSelectionContext,
    DocumentFormat,
    InlineFormatCommand,
    InsertContentCommand,
} from "../../formats/types";
import {
    findSourceBlockAtOffset,
    isSourceSelection,
    type SourceBlock,
} from "../core/types";
import {
    findBlock,
    getEditorBlocks,
} from "../blocks/view";
import {
    createDeleteTransaction,
    createInsertTextTransaction,
    createPasteTransaction,
} from "../core/commands";
import {
    createSelectionBookmark,
    canRedoSourceHistory,
    canUndoSourceHistory,
    dispatch,
    flushSourceHistoryBatch,
    getEditorState,
    redoSourceHistory,
    undoSourceHistory,
} from "../core/store";
import {
    activateSourceToken,
    clearSourceReveal,
    clearInlineTypingSourceReveal,
    domPointToSourceOffset,
    moveSourceSelectionVertically,
    selectionTouchesSource,
    resetVerticalNavigationAffinity,
    readSourceTokenDocumentRange,
    syncDomSelectionFromState,
    syncStateSelectionFromDom,
} from "../core/projection";
import { reportEditorError } from "../editor-status";
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

const supportedPastedImageMimeTypes = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);
const maxRichClipboardHtmlLength = 5 * 1024 * 1024;

type ActiveTableCellEditor = {
    input: HTMLInputElement;
    cell: HTMLTableCellElement;
    blockId: string;
    row: number;
    column: number;
    from: number;
    to: number;
    finishing: boolean;
};

type TableCellAddress = {
    tableIndex: number;
    row: number;
    column: number;
};

type ActiveInlineObjectSelection = {
    token: HTMLElement;
    toolbar: HTMLElement;
    from: number;
    to: number;
};

export type EditorCommand =
    | "undo"
    | "redo"
    | "select-all"
    | "bold"
    | "italic"
    | "strike"
    | "inline-code"
    | "link"
    | `block:${BlockFormatCommand}`
    | `insert:${InsertContentCommand}`
    | "copy"
    | "cut"
    | "paste";

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
    let clipboardOperationId = 0;
    let internalDrag: {
        sessionId: number;
        revision: number;
        from: number;
        to: number;
        source: string;
    } | null = null;
    let activeTableCellEditor: ActiveTableCellEditor | null = null;
    let scheduledTableCellTimer: number | null = null;
    let activeInlineObject: ActiveInlineObjectSelection | null = null;
    const pendingInlineFormats = new Set<Exclude<InlineFormatCommand, "link">>();
    let pendingInlineFormatOffset: number | null = null;

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
                syncDomSelectionFromState({ focus: "editor" });
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
                syncDomSelectionFromState({ focus: "editor" });
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
            syncDomSelectionFromState();
            return;
        }

        if (command === "paste") {
            syncSourceSelectionForCommand();
            const bookmark = createSelectionBookmark();
            try {
                const result = supportsRichSourceEditing()
                    ? await readNativeRichClipboard()
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

    async function writeNativeClipboard(
        payload: ClipboardPayload,
        includeMarkdown: boolean,
    ): Promise<void> {
        if (navigator.clipboard?.write && typeof ClipboardItem === "function") {
            try {
                const clipboardData: Record<string, Blob> = {
                    "text/plain": new Blob([payload.plainText], { type: "text/plain" }),
                    "text/html": new Blob([payload.html], { type: "text/html" }),
                };
                if (includeMarkdown && (typeof ClipboardItem.supports !== "function" || ClipboardItem.supports("text/markdown"))) {
                    clipboardData["text/markdown"] = new Blob([payload.markdown], { type: "text/markdown" });
                }
                await navigator.clipboard.write([new ClipboardItem(clipboardData)]);
                return;
            } catch {
                // Wails clipboard is the permission-safe desktop fallback.
            }
        }
        await Clipboard.SetText(payload.markdown);
    }

    async function readNativeRichClipboard(): Promise<ClipboardReadResult> {
        if (navigator.clipboard?.read) {
            try {
                const items = await navigator.clipboard.read();
                const item = items[0];
                if (item) {
                    const imageTypes = item.types.filter((type) => supportedPastedImageMimeTypes.has(type.toLowerCase()));
                    const hasMarkdown = item.types.includes("text/markdown");
                    const html = imageTypes.length > 0 && item.types.includes("text/html")
                        ? await (await item.getType("text/html")).text()
                        : "";
                    if (
                        imageTypes.length > 0 &&
                        !hasMarkdown &&
                        (!html || !hasMeaningfulNonImageClipboardHtml(html))
                    ) {
                        const files = await Promise.all(imageTypes.map(async (type, index) => {
                            const blob = await item.getType(type);
                            return new File([blob], `clipboard-image-${index + 1}.${extensionForImageMimeType(type)}`, { type });
                        }));
                        return { kind: "images", files };
                    }
                }
                for (const type of ["text/markdown", "text/html", "text/plain"] as const) {
                    if (!item?.types.includes(type)) continue;
                    const value = await (await item.getType(type)).text();
                    if (type === "text/html" && value.length > maxRichClipboardHtmlLength) {
                        return {
                            kind: "plain",
                            value: new DOMParser().parseFromString(value, "text/html").body.textContent?.replace(/\r\n?/g, "\n") ?? "",
                            warning: "Rich clipboard content exceeded 5 MB and was pasted as plain text.",
                        };
                    }
                    return {
                        kind: type === "text/markdown" ? "markdown" : type === "text/html" ? "html" : "plain",
                        value: type === "text/html"
                            ? options.getActiveDocumentFormat().clipboard?.convertHtml?.(value) ?? value
                            : value.replace(/\r\n?/g, "\n"),
                    };
                }
            } catch {
                // Wails clipboard is the permission-safe desktop fallback.
            }
        }
        return { kind: "plain", value: (await Clipboard.Text()).replace(/\r\n?/g, "\n") };
    }

    async function readNativePlainClipboard(): Promise<string> {
        if (navigator.clipboard?.readText) {
            try {
                return (await navigator.clipboard.readText()).replace(/\r\n?/g, "\n");
            } catch {
                // Wails clipboard is the permission-safe desktop fallback.
            }
        }
        return (await Clipboard.Text()).replace(/\r\n?/g, "\n");
    }

    function escapeClipboardText(value: string): string {
        return `<pre>${value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`;
    }

    function deactivate(): void {
        cancelScheduledTableCellEditor();
        clearPendingInlineFormats();
        clearInlineObjectSelection();
        finishTableCellEditor(true);
        flushSourceHistoryBatch();
        resetVerticalNavigationAffinity();
        clearSourceReveal();
        options.syncActiveBlockIndicator(null);
    }

    function containsExternalInteractionTarget(target: EventTarget | null): boolean {
        return target instanceof Node && Boolean(
            activeTableCellEditor?.input.contains(target) ||
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
                finishTableCellEditor(true);
                if (block) {
                    editBlockObjectSource(block, true);
                }
                return;
            }
            if (activeTableCellEditor?.cell === tableCell) {
                activeTableCellEditor.input.focus({ preventScroll: true });
            } else {
                startTableCellEditor(tableCell);
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
            if (targetRange) {
                preCompositionSourceSelection = {
                    anchor: domPointToSourceOffset(targetRange.startContainer, targetRange.startOffset),
                    head: domPointToSourceOffset(targetRange.endContainer, targetRange.endOffset),
                };
            }
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
        isComposingText = true;
        syncStateSelectionFromDom();
        preCompositionSourceSelection = getEditorState().selection;
        compositionLease = {
            sessionId: documentState.sessionId,
            revision: getEditorState().revision,
        };
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
        const insert = event.data ?? "";
        const lease = compositionLease;
        compositionLease = null;
        if (!lease || lease.sessionId !== documentState.sessionId || lease.revision !== getEditorState().revision) {
            syncDomSelectionFromState({ focus: "preserve" });
            return;
        }
        if (insert) {
            const state = getEditorState();
            dispatch(createSourceInsertTextTransaction(
                { ...state, selection: preCompositionSourceSelection },
                prepareVirtualEofInsertion(insert, preCompositionSourceSelection),
            ));
        } else {
            syncDomSelectionFromState({ focus: "editor" });
        }
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
            if (activeTableCellEditor?.cell !== tableCell) {
                startTableCellEditor(tableCell);
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
        syncDomSelectionFromState({ focus: "editor" });
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
        syncDomSelectionFromState({ focus: "editor" });
    }

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
        delete block.dataset.blockSourceActive;

        const input = document.createElement("input");
        input.className = "table-cell-editor";
        input.type = "text";
        input.value = source.slice(range.start, range.end);
        input.setAttribute("aria-label", `Table row ${row === 0 ? "header" : row}, column ${column + 1}`);
        const cellRect = cell.getBoundingClientRect();
        input.style.left = `${cellRect.left}px`;
        input.style.top = `${cellRect.top}px`;
        input.style.width = `${cellRect.width}px`;
        input.style.height = `${cellRect.height}px`;
        cell.dataset.tableCellEditing = "true";
        document.body.append(input);
        activeTableCellEditor = {
            input,
            cell,
            blockId,
            row,
            column,
            from: sourceBlock.sourceFrom + range.start,
            to: sourceBlock.sourceFrom + range.end,
            finishing: false,
        };
        for (const type of ["pointerdown", "click", "beforeinput", "input", "copy", "cut", "paste"] as const) {
            input.addEventListener(type, (event) => event.stopPropagation());
        }
        input.addEventListener("keydown", (event) => {
            event.stopPropagation();
            if (event.key === "Escape") {
                event.preventDefault();
                finishTableCellEditor(false);
            } else if (event.key === "Tab" || event.key === "Enter") {
                event.preventDefault();
                finishTableCellEditor(true, event.shiftKey ? -1 : 1);
            }
        });
        input.addEventListener("blur", () => finishTableCellEditor(true));
        input.focus({ preventScroll: true });
        input.select();
    }

    function finishTableCellEditor(commit: boolean, move?: -1 | 1): void {
        const active = activeTableCellEditor;
        if (!active || active.finishing) return;
        const nextCell = move ? readAdjacentTableCellAddress(active, move) : null;
        active.finishing = true;
        activeTableCellEditor = null;
        active.input.remove();
        active.cell.removeAttribute("data-table-cell-editing");
        if (!commit) {
            return;
        }
        const value = active.input.value.replace(/\r?\n/g, " ").replace(/(?<!\\)\|/g, "\\|");
        dispatch({
            changes: [{ from: active.from, to: active.to, insert: value }],
            selection: { anchor: active.from + value.length, head: active.from + value.length },
            annotations: { userEvent: "input", historyMode: "discrete" },
        });
        if (move) {
            const transaction = createTableTabTransaction(getEditorState(), move);
            if (transaction) dispatch(transaction);
            if (transaction && nextCell) scheduleTableCellEditor(nextCell);
        }
    }

    function readAdjacentTableCellAddress(active: ActiveTableCellEditor, move: -1 | 1): TableCellAddress | null {
        const sourceBlock = getEditorState().blocks.blocks.find((candidate) => candidate.id === active.blockId);
        const table = active.cell.closest<HTMLTableElement>(".markdown-table");
        const tableIndex = table ? Array.from(document.querySelectorAll(".markdown-table")).indexOf(table) : -1;
        if (!sourceBlock || tableIndex < 0) return null;
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
        return row < 0 ? null : { tableIndex, row, column };
    }

    function scheduleTableCellEditor(address: TableCellAddress): void {
        cancelScheduledTableCellEditor();
        // Selection projection for a newly inserted row can emit a deferred
        // selectionchange after the transaction. Open the next cell after that
        // browser task has settled so it cannot immediately steal focus back.
        scheduledTableCellTimer = window.setTimeout(() => {
            scheduledTableCellTimer = null;
            openTableCellEditor(address);
        }, 32);
    }

    function cancelScheduledTableCellEditor(): void {
        if (scheduledTableCellTimer === null) return;
        window.clearTimeout(scheduledTableCellTimer);
        scheduledTableCellTimer = null;
    }

    function openTableCellEditor(address: TableCellAddress): void {
        const table = document.querySelectorAll<HTMLTableElement>(".markdown-table")[address.tableIndex];
        const cell = table?.querySelector<HTMLTableCellElement>(
            `[data-table-source-row="${address.row}"][data-table-source-column="${address.column}"]`,
        ) ?? null;
        if (cell) startTableCellEditor(cell);
    }

    function handleSourceKeydown(event: KeyboardEvent): boolean {
        if (isComposingText) {
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
                syncDomSelectionFromState({ focus: "editor" });
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
                syncDomSelectionFromState({ focus: "editor" });
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
            syncDomSelectionFromState();
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
                dispatch(createSourceInsertTextTransaction(state, "\t"));
                return true;
            }

            event.preventDefault();
            dispatch(transaction);
            syncDomSelectionFromState();
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
                    syncDomSelectionFromState({ focus: "editor" });
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
            const token = document.querySelector<HTMLElement>(".markdown-token-editing");
            const range = token ? readSourceTokenDocumentRange(token) : null;
            if (range) {
                event.preventDefault();
                clearInlineTypingSourceReveal();
                clearSourceReveal();
                dispatch({
                    changes: [],
                    selection: {
                        anchor: range.to,
                        head: range.to,
                        anchorAffinity: "upstream",
                        headAffinity: "upstream",
                    },
                    annotations: { userEvent: "programmatic", addToHistory: false },
                });
                syncDomSelectionFromState({ focus: "editor" });
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
            target = event.ctrlKey || event.metaKey ? 0 : previousLineBoundary(state.doc, currentHead);
        } else if (event.key === "End") {
            target = event.ctrlKey || event.metaKey ? state.doc.length : nextLineBoundary(state.doc, currentHead);
        } else if (event.ctrlKey || event.altKey) {
            target = backward
                ? previousWordBoundary(state.doc, currentHead)
                : nextWordBoundary(state.doc, currentHead);
        } else {
            target = backward
                ? previousGraphemeBoundary(state.doc, currentHead)
                : nextGraphemeBoundary(state.doc, currentHead);
        }

        let extendedAnchor = state.selection.anchor === state.selection.head
            ? currentHead
            : state.selection.anchor;

        const nextSelection = {
            anchor: event.shiftKey ? extendedAnchor : target,
            head: target,
        };
        dispatch({
            changes: [],
            selection: {
                ...nextSelection,
                source: selectionTouchesSource(nextSelection),
            },
            annotations: { userEvent: "programmatic", addToHistory: false },
        });
        syncDomSelectionFromState({ focus: "editor" });
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
                syncDomSelectionFromState();
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
                syncDomSelectionFromState({ focus: "editor" });
            }
        }
        return true;
    }

    function readSourceBeforeInputTransaction(event: InputEvent): (() => Parameters<typeof dispatch>[0] | null) | null {
        if (
            (event.inputType === "insertText" || event.inputType === "insertReplacementText") &&
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

        // Some replacement sources provide their text through dataTransfer
        // rather than InputEvent.data. Preserve the source-first path for
        // those replacements and safely cancel non-text replacements.
        if (event.inputType === "insertReplacementText") {
            const replacement = event.dataTransfer?.getData("text/plain");
            if (replacement !== undefined && replacement !== null) {
                return () => createSourceInsertTextTransaction(getEditorState(), replacement);
            }
            return () => null;
        }

        if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") {
            return () => {
                const state = getEditorState();
                return (!options.isSourceMode()
                    ? options.getActiveDocumentFormat().editing?.createEnterTransaction?.(state)
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
        const selectedText = clipboardSelection
            ? state.doc.slice(clipboardSelection.anchor, clipboardSelection.head)
            : null;
        if (selectedText === null || !event.clipboardData) {
            return preventUnmappedSourceClipboardDefault(event);
        }

        event.preventDefault();
        if (!writeSourceClipboard(event.clipboardData, selectedText)) {
            syncDomSelectionFromState();
        }
        return true;
    }

    function handleSourceCut(event: ClipboardEvent): boolean {
        syncSourceSelectionForCommand();
        const state = getEditorState();
        const clipboardSelection = readClipboardSelection(state);
        const selectedText = clipboardSelection
            ? state.doc.slice(clipboardSelection.anchor, clipboardSelection.head)
            : null;
        const transaction = clipboardSelection
            ? createSourceDeleteTransaction(
                { ...state, selection: clipboardSelection },
                "forward",
                "grapheme",
            )
            : null;
        if (selectedText === null || !transaction || !event.clipboardData) {
            return preventUnmappedSourceClipboardDefault(event);
        }

        event.preventDefault();
        if (!writeSourceClipboard(event.clipboardData, selectedText)) {
            syncDomSelectionFromState();
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
        syncDomSelectionFromState();
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
                    syncDomSelectionFromState({ focus: "editor" });
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

    function writeSourceClipboard(clipboard: DataTransfer, _text: string): boolean {
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

function readClipboardImages(dataTransfer: DataTransfer | null | undefined): File[] {
    if (!dataTransfer) {
        return [];
    }

    const fromItems = Array.from(dataTransfer.items)
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file && isSupportedPastedImage(file)));
    return fromItems.length > 0
        ? fromItems
        : Array.from(dataTransfer.files).filter(isSupportedPastedImage);
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

function hasMeaningfulNonImageClipboardHtml(html: string): boolean {
    if (!html) {
        return false;
    }
    const clipboardDocument = new DOMParser().parseFromString(html, "text/html");
    for (const element of Array.from(clipboardDocument.body.querySelectorAll("script, style, img"))) {
        element.remove();
    }
    if (clipboardDocument.body.textContent?.trim()) {
        return true;
    }
    return Boolean(clipboardDocument.body.querySelector(
        "br, hr, table, ul, ol, pre, blockquote, input, textarea, select, video, audio, canvas, svg",
    ));
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

function extensionForImageMimeType(mimeType: string): string {
    if (mimeType === "image/jpeg") return "jpg";
    if (mimeType === "image/gif") return "gif";
    if (mimeType === "image/webp") return "webp";
    return "png";
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
