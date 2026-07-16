import { getSuggestedFileName } from "../../app/window-title";
import { Clipboard } from "@wailsio/runtime";
import { savePastedImage } from "../../bridge/documents";
import {
    matchesShortcutCommand,
    readInlineFormatShortcut,
} from "../../app/keymap";
import type {
    ClipboardPayload,
    DocumentFormat,
} from "../../formats/types";
import type { DocumentEditorHooks } from "../core/types";
import {
    findBlock,
} from "../blocks/view";
import {
    createCutTransaction,
    createDeleteBackwardTransaction,
    createDeleteForwardTransaction,
    createDeleteTransaction,
    createInsertTextTransaction,
    createPasteTransaction,
    readSelectedSourceText,
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

const supportedPastedImageMimeTypes = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

export type EditorInputController = {
    deactivate: () => void;
    handleEditorMouseDown: (event: MouseEvent) => void;
    handleEditorChange: (event: Event) => void;
    handleEditorKeydown: (event: KeyboardEvent) => void;
    handleEditorBeforeInput: (event: InputEvent) => void;
    handleEditorCompositionStart: () => void;
    handleEditorCompositionEnd: (event: CompositionEvent) => void;
    handleEditorInput: (event: Event) => void;
    handleEditorPaste: (event: ClipboardEvent) => void;
    handleEditorCopy: (event: ClipboardEvent) => void;
    handleEditorCut: (event: ClipboardEvent) => void;
    handleEditorDragOver: (event: DragEvent) => void;
    handleEditorDrop: (event: DragEvent) => void;
    handleEditorClick: (event: MouseEvent) => void;
    isComposingText: () => boolean;
    executeCommand: (command: EditorCommand) => Promise<void>;
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
    ensureDocumentSaved: (options: { promptForPath: boolean; suggestedFileName: string }) => Promise<boolean>;
};

export function createEditorInputController(options: EditorInputControllerOptions): EditorInputController {
    let isComposingText = false;
    let preCompositionSourceSelection = getEditorState().selection;

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
        handleEditorDragOver,
        handleEditorDrop,
        handleEditorClick,
        isComposingText: () => isComposingText,
        executeCommand,
    };

    async function executeCommand(command: EditorCommand): Promise<void> {
        const activeTextInput = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement
            ? document.activeElement
            : null;

        if (command === "undo" || command === "redo") {
            if (!activeTextInput) {
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
                const text = supportsRichSourceEditing()
                    ? await readNativeRichClipboard()
                    : await readNativePlainClipboard();
                const selection = bookmark.read();
                if (text && selection) {
                    const state = getEditorState();
                    dispatch(createPasteTransaction({ ...state, selection }, text));
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
        const selectedText = readSelectedSourceText(state);
        if (selectedText === null) {
            return;
        }
        const bookmark = createSelectionBookmark(state.selection);
        try {
            await writeNativeClipboard(createClipboardPayload(selectedText), supportsRichSourceEditing());
            if (command === "cut") {
                const selection = bookmark.read();
                if (selection) {
                    const current = getEditorState();
                    const transaction = createCutTransaction({ ...current, selection });
                    if (transaction) {
                        dispatch(transaction);
                    }
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

    async function readNativeRichClipboard(): Promise<string> {
        if (navigator.clipboard?.read) {
            try {
                const items = await navigator.clipboard.read();
                for (const type of ["text/markdown", "text/html", "text/plain"] as const) {
                    const item = items.find((candidate) => candidate.types.includes(type));
                    if (!item) continue;
                    const value = await (await item.getType(type)).text();
                    return type === "text/html"
                        ? options.getActiveDocumentFormat().clipboard?.convertHtml?.(value) ?? value
                        : value.replace(/\r\n?/g, "\n");
                }
            } catch {
                // Wails clipboard is the permission-safe desktop fallback.
            }
        }
        return (await Clipboard.Text()).replace(/\r\n?/g, "\n");
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

    function handleEditorMouseDown(event: MouseEvent): void {
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
    }

    function handleEditorCompositionEnd(event: CompositionEvent): void {
        isComposingText = false;
        const insert = event.data ?? "";
        if (insert) {
            const state = getEditorState();
            dispatch(createInsertTextTransaction({ ...state, selection: preCompositionSourceSelection }, insert));
        } else {
            syncDomSelectionFromState();
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
        if (event.dataTransfer?.types.includes("text/plain") || readClipboardImage(event.dataTransfer)) {
            event.preventDefault();
        }
    }

    function handleEditorDrop(event: DragEvent): void {
        handleEditorDropFromFormatOrGeneric(event);
    }

    function handleEditorDropFromFormatOrGeneric(event: DragEvent): void {
        handleSourceDrop(event);
    }

    function handleEditorClick(event: MouseEvent): void {
        const link = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[href]");
        if (link && (event.ctrlKey || event.metaKey)) {
            window.open(link.href, "_blank", "noopener,noreferrer");
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
                ?? createInsertTextTransaction(state, "\n"),
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
                dispatch(createInsertTextTransaction(state, "\t"));
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
            const transaction = createDeleteTransaction(
                getEditorState(),
                event.key === "Backspace" ? "backward" : "forward",
                readDeleteGranularityFromKeydown(event),
            );
            if (transaction) {
                dispatch(transaction);
            }
            return true;
        }

        if (isPlainVerticalNavigationKey(event)) {
            syncStateSelectionFromDom();
            if (moveSourceSelectionVertically(event.key === "ArrowUp" ? "up" : "down")) {
                event.preventDefault();
                return true;
            }
            return false;
        }

        return false;
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
        }
        return true;
    }

    function readSourceBeforeInputTransaction(event: InputEvent): (() => Parameters<typeof dispatch>[0] | null) | null {
        if (
            (event.inputType === "insertText" || event.inputType === "insertReplacementText") &&
            event.data !== null
        ) {
            return () => createInsertTextTransaction(getEditorState(), event.data ?? "");
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
                return () => createInsertTextTransaction(getEditorState(), replacement);
            }
            return () => null;
        }

        if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") {
            return () => {
                const state = getEditorState();
                return options.getActiveDocumentFormat().editing?.createEnterTransaction?.(state)
                    ?? createInsertTextTransaction(state, "\n");
            };
        }

        if (event.inputType === "deleteContentBackward") {
            return () => createDeleteBackwardTransaction(getEditorState());
        }

        if (event.inputType === "deleteContentForward") {
            return () => createDeleteForwardTransaction(getEditorState());
        }

        if (event.inputType === "deleteWordBackward") {
            return () => createDeleteTransaction(getEditorState(), "backward", "word");
        }

        if (event.inputType === "deleteWordForward") {
            return () => createDeleteTransaction(getEditorState(), "forward", "word");
        }

        if (event.inputType === "deleteSoftLineBackward" || event.inputType === "deleteHardLineBackward") {
            return () => createDeleteTransaction(
                getEditorState(),
                "backward",
                event.inputType === "deleteSoftLineBackward" ? "soft-line" : "hard-line",
            );
        }

        if (event.inputType === "deleteSoftLineForward" || event.inputType === "deleteHardLineForward") {
            return () => createDeleteTransaction(
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
        const selectedText = readSelectedSourceText(getEditorState());
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
        const selectedText = readSelectedSourceText(getEditorState());
        const transaction = createCutTransaction(getEditorState());
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
        const insert = supportsRichSourceEditing()
            ? options.getActiveDocumentFormat().clipboard?.read?.(event.clipboardData) ?? ""
            : event.clipboardData?.getData("text/plain").replace(/\r\n?/g, "\n") ?? "";
        if (!insert) {
            const image = supportsRichSourceEditing() ? readClipboardImage(event.clipboardData) : null;
            if (!image) {
                return false;
            }

            event.preventDefault();
            syncStateSelectionFromDom();
            void pasteSourceImage(image, createSelectionBookmark());
            return true;
        }

        event.preventDefault();
        pasteSourceText(insert);
        return true;
    }

    function handleSourceDrop(event: DragEvent): boolean {
        const text = readDroppedText(event.dataTransfer);
        const image = supportsRichSourceEditing() ? readClipboardImage(event.dataTransfer) : null;
        if (!text && !image) {
            return false;
        }

        event.preventDefault();
        syncSourceSelectionFromDropPoint(event);
        if (text) {
            dispatch(createPasteTransaction(getEditorState(), text));
        } else if (image) {
            void pasteSourceImage(image, createSelectionBookmark());
        }

        return true;
    }

    async function pasteSourceImage(
        image: File,
        bookmark: ReturnType<typeof createSelectionBookmark>,
    ): Promise<void> {
        try {
            let activeFilePath = options.getActiveFilePath();
            if (!activeFilePath) {
                const saved = await options.ensureDocumentSaved({
                    promptForPath: true,
                    suggestedFileName: getSuggestedFileName(),
                });
                if (!saved) {
                    return;
                }

                activeFilePath = options.getActiveFilePath();
            }

            if (!activeFilePath) {
                return;
            }

            const dataUrl = await readFileAsDataUrl(image);
            const pastedImage = await savePastedImage(activeFilePath, dataUrl, image.name, image.type);
            const selection = bookmark.read();
            if (!selection) {
                return;
            }

            const state = getEditorState();
            const source = options.getActiveDocumentFormat().editing?.createPastedImageSource?.(
                pastedImage.relativePath,
                image.name,
            );
            if (source) {
                dispatch(createPasteTransaction({ ...state, selection }, source));
            }
        } catch (error) {
            console.error("Failed to paste image:", error);
            reportEditorError("Could not save the pasted image.");
        } finally {
            bookmark.dispose();
        }
    }

    function pasteSourceText(text: string): void {
        syncStateSelectionFromDom();
        dispatch(createPasteTransaction(getEditorState(), text));
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

    function writeSourceClipboard(clipboard: DataTransfer, text: string): boolean {
        try {
            if (supportsRichSourceEditing()) {
                const write = options.getActiveDocumentFormat().clipboard?.write;
                if (!write) {
                    return false;
                }
                write(clipboard, text);
            } else {
                clipboard.setData("text/plain", text);
            }
            return true;
        } catch (error) {
            console.error("Failed to populate the source clipboard:", error);
            return false;
        }
    }

    function isPlainVerticalNavigationKey(event: KeyboardEvent): boolean {
        return (
            (event.key === "ArrowUp" || event.key === "ArrowDown") &&
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.shiftKey
        );
    }

    function createClipboardPayload(text: string): ClipboardPayload {
        return supportsRichSourceEditing()
            ? options.getActiveDocumentFormat().clipboard?.createPayload?.(text)
                ?? { markdown: text, plainText: text, html: escapeClipboardText(text) }
            : { markdown: text, plainText: text, html: escapeClipboardText(text) };
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

function readClipboardImage(dataTransfer: DataTransfer | null | undefined): File | null {
    if (!dataTransfer) {
        return null;
    }

    for (const item of Array.from(dataTransfer.items)) {
        if (item.kind === "file" && supportedPastedImageMimeTypes.has(item.type.toLowerCase())) {
            return item.getAsFile();
        }
    }

    return Array.from(dataTransfer.files).find((file) => supportedPastedImageMimeTypes.has(file.type.toLowerCase())) ?? null;
}

function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => {
            if (typeof reader.result === "string") {
                resolve(reader.result);
            } else {
                reject(new Error("Unable to read image data"));
            }
        });
        reader.addEventListener("error", () => reject(reader.error ?? new Error("Unable to read image data")));
        reader.readAsDataURL(file);
    });
}

function isPlainTextKeydown(event: KeyboardEvent): boolean {
    return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
}
