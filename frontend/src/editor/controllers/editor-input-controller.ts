import { documentState } from "../../documents/document-state";
import { Clipboard } from "@wailsio/runtime";
import {
    isSupportedPastedImage,
    persistImageFiles,
    stagePendingImages,
} from "../../formats/markdown/pending-images";
import {
    matchesShortcutCommand,
    readInlineFormatShortcut,
} from "../../app/keymap";
import type {
    ClipboardPayload,
    ClipboardReadResult,
    ClipboardSelectionContext,
    DocumentFormat,
} from "../../formats/types";
import {
    findSourceBlockAtOffset,
    readVisibleListPrefixLength,
    type DocumentEditorHooks,
    type EditorState,
} from "../core/types";
import {
    findBlock,
} from "../blocks/view";
import {
    createCutTransaction,
    createDeleteTransaction,
    createInsertTextTransaction,
    createPasteTransaction,
} from "../core/commands";
import {
    createSelectionBookmark,
    dispatch,
    flushSourceHistoryBatch,
    getEditorState,
    redoSourceHistory,
    undoSourceHistory,
} from "../core/store";
import {
    clearInlineSourceReveal,
    domPointToSourceOffset,
    moveSourceSelectionVertically,
    resetVerticalNavigationAffinity,
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

export type EditorInputController = {
    deactivate: () => void;
    handleEditorMouseDown: (event: PointerEvent) => void;
    handleEditorChange: (event: Event) => void;
    handleEditorKeydown: (event: KeyboardEvent) => void;
    handleEditorBeforeInput: (event: InputEvent) => void;
    handleEditorCompositionStart: () => void;
    handleEditorCompositionEnd: (event: CompositionEvent) => void;
    handleEditorInput: (event: Event) => void;
    handleEditorPaste: (event: ClipboardEvent) => void;
    handleEditorCopy: (event: ClipboardEvent) => void;
    handleEditorCut: (event: ClipboardEvent) => void;
    handleEditorDragStart: (event: DragEvent) => void;
    handleEditorDragEnd: () => void;
    handleEditorDragOver: (event: DragEvent) => void;
    handleEditorDrop: (event: DragEvent) => void;
    handleEditorClick: (event: MouseEvent) => void;
    isComposingText: () => boolean;
    executeCommand: (command: EditorCommand, focusOwner?: Element | null) => Promise<void>;
};

export type EditorCommand =
    | "undo"
    | "redo"
    | "select-all"
    | "bold"
    | "italic"
    | "copy"
    | "cut"
    | "paste";

type EditorInputControllerOptions = {
    hooks: DocumentEditorHooks;
    getActiveDocumentFormat: () => DocumentFormat;
    getActiveFilePath: () => string | null;
};

export function createEditorInputController(options: EditorInputControllerOptions): EditorInputController {
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

    return {
        deactivate,
        handleEditorMouseDown,
        handleEditorChange,
        handleEditorKeydown,
        handleEditorBeforeInput,
        handleEditorCompositionStart,
        handleEditorCompositionEnd,
        handleEditorInput,
        handleEditorPaste,
        handleEditorCopy,
        handleEditorCut,
        handleEditorDragStart,
        handleEditorDragEnd,
        handleEditorDragOver,
        handleEditorDrop,
        handleEditorClick,
        isComposingText: () => isComposingText,
        executeCommand,
    };

    async function executeCommand(command: EditorCommand, focusOwner?: Element | null): Promise<void> {
        const commandFocusOwner = focusOwner ?? document.activeElement;
        const activeTextInput = commandFocusOwner instanceof HTMLInputElement || commandFocusOwner instanceof HTMLTextAreaElement
            ? commandFocusOwner
            : null;

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

        if (command === "bold" || command === "italic") {
            if (!supportsRichSourceEditing() || activeTextInput) {
                return;
            }
            syncSourceSelectionForCommand();
            const transaction = options.getActiveDocumentFormat().editing?.createInlineFormatTransaction?.(
                getEditorState(),
                command === "bold" ? "**" : "*",
            );
            if (transaction) {
                dispatch(transaction);
            } else {
                reportEditorError("No formattable text selected");
            }
            return;
        }

        if (activeTextInput) {
            await executeTextInputClipboardCommand(activeTextInput, command);
            return;
        }

        if (command === "select-all") {
            dispatch({
                changes: [],
                selection: { anchor: 0, head: getEditorState().doc.length },
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
                        const transaction = createCutTransaction({ ...current, selection });
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
                    if (imageTypes.length > 0 && !item.types.some((type) => type.startsWith("text/"))) {
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
        flushSourceHistoryBatch();
        resetVerticalNavigationAffinity();
        clearInlineSourceReveal();
        options.hooks.syncBlockSourceReveal(null);
        options.hooks.syncActiveBlockIndicator(null);
    }

    function handleEditorMouseDown(event: PointerEvent): void {
        resetVerticalNavigationAffinity();
        flushSourceHistoryBatch();
        handleEditorMouseDownCommand(event);
    }

    function handleEditorChange(event: Event): void {
        const target = event.target;
        if (target instanceof HTMLInputElement && target.classList.contains("todo-checkbox")) {
            const block = findBlock(target);
            const blockId = block?.dataset.blockId;
            const transaction = blockId
                ? options.getActiveDocumentFormat().editing?.createCheckboxToggleTransaction?.(getEditorState(), blockId)
                : null;
            if (transaction) {
                dispatch(transaction);
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
        isComposingText = true;
        syncStateSelectionFromDom();
        preCompositionSourceSelection = getEditorState().selection;
        compositionLease = {
            sessionId: documentState.sessionId,
            revision: getEditorState().revision,
        };
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

    function handleEditorInput(_event: Event): void {
    }

    function handleEditorPaste(event: ClipboardEvent): void {
        handleEditorPasteFromFormatOrGeneric(event);
    }

    function handleEditorCopy(event: ClipboardEvent): void {
        handleSourceCopy(event);
    }

    function handleEditorCut(event: ClipboardEvent): void {
        handleSourceCut(event);
    }

    function handleEditorPasteFromFormatOrGeneric(event: ClipboardEvent): void {
        handleSourcePaste(event);
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
        const from = Math.min(state.selection.anchor, state.selection.head);
        const to = Math.max(state.selection.anchor, state.selection.head);
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
        event.dataTransfer.effectAllowed = "copyMove";
        event.dataTransfer.setData("text/markdown", source);
        event.dataTransfer.setData("text/plain", source);
    }

    function handleEditorDragEnd(): void {
        internalDrag = null;
    }

    function handleEditorDrop(event: DragEvent): void {
        handleEditorDropFromFormatOrGeneric(event);
    }

    function handleEditorDropFromFormatOrGeneric(event: DragEvent): void {
        handleSourceDrop(event);
    }

    function handleEditorClick(event: MouseEvent): void {
        const link = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[href]");
        if (!link) {
            return;
        }
        event.preventDefault();
        if (!(event.ctrlKey || event.metaKey)) {
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

    function handleSourceKeydown(event: KeyboardEvent): boolean {
        if (isComposingText) {
            return true;
        }

        // Let beforeinput perform source-first range edits. The legacy Markdown
        // keydown handler mutates DOM ranges directly, while handling deletion
        // here can race selection projection; both leave EditorState out of sync.
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
                options.getActiveDocumentFormat().editing?.createEnterTransaction?.(state, { shiftKey: event.shiftKey })
                ?? createSourceInsertTextTransaction(state, "\n"),
            );
            syncDomSelectionFromState();
            return true;
        }

        if (event.key === "Tab") {
            syncStateSelectionFromDom();
            const state = getEditorState();
            const transaction = options.getActiveDocumentFormat().editing?.createTabTransaction?.(
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
        const backward = event.key === "ArrowLeft" || event.key === "Home";
        let target: number;

        if (!event.shiftKey && state.selection.anchor !== state.selection.head && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
            target = backward
                ? Math.min(state.selection.anchor, state.selection.head)
                : Math.max(state.selection.anchor, state.selection.head);
        } else if (event.key === "Home") {
            target = event.ctrlKey || event.metaKey ? 0 : previousLineBoundary(state.doc, state.selection.head);
        } else if (event.key === "End") {
            target = event.ctrlKey || event.metaKey ? state.doc.length : nextLineBoundary(state.doc, state.selection.head);
        } else if (event.ctrlKey || event.altKey) {
            target = backward
                ? previousWordBoundary(state.doc, state.selection.head)
                : nextWordBoundary(state.doc, state.selection.head);
        } else {
            target = backward
                ? previousGraphemeBoundary(state.doc, state.selection.head)
                : nextGraphemeBoundary(state.doc, state.selection.head);
        }

        target = normalizeHiddenListIndentNavigationTarget(
            state,
            state.selection.head,
            target,
            backward,
            event.key === "Home" && !event.ctrlKey && !event.metaKey,
        );

        dispatch({
            changes: [],
            selection: {
                anchor: event.shiftKey ? state.selection.anchor : target,
                head: target,
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
                return createSourceInsertTextTransaction(
                    state,
                    prepareVirtualEofInsertion(event.data ?? "", state.selection),
                );
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
                return options.getActiveDocumentFormat().editing?.createEnterTransaction?.(state)
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
            ? createCutTransaction({ ...state, selection: clipboardSelection })
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
                const replacement = staged.sources[index]?.source ?? "";
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
        if (text) {
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
        } else {
            void pasteSourceImages(images, createSelectionBookmark());
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
                const source = prepareVirtualEofInsertion(sources.join("\n\n"), mappedSelection);
                dispatch(createSourcePasteTransaction({ ...state, selection: mappedSelection }, source));
                if (lease.focusOwner && document.activeElement === lease.focusOwner) {
                    syncDomSelectionFromState({ focus: "editor" });
                }
            }
        } catch (error) {
            console.error("Failed to paste image:", error);
            reportEditorError(error instanceof Error ? error.message : "Could not save the pasted image.");
        } finally {
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
        const format = options.getActiveDocumentFormat();
        return Boolean(format.clipboard?.richHtml && format.clipboard.mimeTypes.includes("text/markdown"));
    }

    function createSourceInsertTextTransaction(
        state: ReturnType<typeof getEditorState>,
        text: string,
    ): Parameters<typeof dispatch>[0] {
        return options.getActiveDocumentFormat().editing?.createInsertTextTransaction?.(state, text)
            ?? createInsertTextTransaction(state, text);
    }

    function createSourcePasteTransaction(
        state: ReturnType<typeof getEditorState>,
        text: string,
    ): Parameters<typeof dispatch>[0] {
        return options.getActiveDocumentFormat().editing?.createPasteTransaction?.(state, text)
            ?? createPasteTransaction(state, text);
    }

    function createSourceDeleteTransaction(
        state: ReturnType<typeof getEditorState>,
        direction: "backward" | "forward",
        granularity: "grapheme" | "word" | "soft-line" | "hard-line",
    ): Parameters<typeof dispatch>[0] | null {
        return options.getActiveDocumentFormat().editing?.createDeleteTransaction?.(state, direction, granularity)
            ?? createDeleteTransaction(state, direction, granularity);
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

function normalizeHiddenListIndentNavigationTarget(
    state: EditorState,
    current: number,
    target: number,
    backward: boolean,
    moveToLineStart: boolean,
): number {
    const block = findSourceBlockAtOffset(state.blocks, current);
    if (
        !block ||
        (block.type !== "list" && block.type !== "ordered-list" && block.type !== "todo") ||
        !block.indent
    ) {
        return target;
    }

    const markerFrom = block.contentFrom - readVisibleListPrefixLength(block);
    if (markerFrom <= block.sourceFrom) {
        return target;
    }

    if (moveToLineStart) {
        return markerFrom;
    }

    if (target >= block.sourceFrom && target < markerFrom) {
        return backward && current <= markerFrom
            ? previousGraphemeBoundary(state.doc, block.sourceFrom)
            : markerFrom;
    }

    return target;
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
