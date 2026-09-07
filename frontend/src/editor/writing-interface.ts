import { createDocumentOutlinePanel } from "./document-outline";
import "./writing-interface.css";
import { commands } from "../app/commands";
import { readShortcutCommand, readShortcutLabel, type AppMenuCommand } from "../app/keymap";
import { appMenuCommandEvent } from "../platform/window-controls/window-controls";
import { documentState, documentStateChangedEvent } from "../documents/document-state";
import { canUseDesktopFileSystem, saveCurrentDocument } from "../documents/document-actions";
import { saveAndCompileLatex } from "../formats/latex/preview";
import { getActiveDocumentFormat, isMarkdownSourceMode, toggleMarkdownEditingMode } from "../documents/document-session";
import type { FileTreeController } from "../documents/file-tree";
import type { createEditorInputController } from "./controllers/editor-input-controller";
import { createSelectionBookmark, dispatch } from "./core/store";
import { syncDomSelectionFromState } from "./core/projection";

type Options = { fileTree: FileTreeController; inputController: ReturnType<typeof createEditorInputController> };
type Item = { id: string; label: string; group: string; shortcut?: string | null; enabled: boolean; active?: boolean; run: () => void };

export function installWritingInterface(options: Options): void {
    const header = document.getElementById("writing-header")!;
    const editor = document.getElementById("editor")!;
    const panel = document.createElement("section");
    panel.className = "writing-panel";
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    document.body.append(panel);
    const nav = button("Open explorer", () => open("files"));
    nav.className = "header-document-button";
    nav.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg>';
    const filename = document.createElement("span");
    filename.className = "header-document-name";
    const unsaved = document.createElement("span");
    unsaved.className = "header-unsaved";
    unsaved.textContent = "\u00b7";
    unsaved.setAttribute("aria-hidden", "true");
    nav.append(filename, unsaved);
    panel.id = "writing-panel";
    for (const control of [nav]) {
        control.setAttribute("aria-haspopup", "dialog");
        control.setAttribute("aria-controls", panel.id);
        control.setAttribute("aria-expanded", "false");
    }
    header.append(nav);
    const exit = button("Exit Focus", () => toggleFocus());
    exit.className = "exit-focus";
    exit.hidden = true;
    document.body.append(exit);
    const titleRow = document.querySelector<HTMLElement>(".document-title-row")!;
    const titleHome = titleRow.parentElement!;
    titleRow.hidden = true;
    const fileFrame = document.querySelector<HTMLElement>(".file-tree-frame")!;
    const outline = createDocumentOutlinePanel();
    const parking = document.createElement("div");
    parking.hidden = true;
    document.body.append(parking);
    parking.append(fileFrame, outline);
    let kind = "";
    let group = "";
    let initiator: HTMLElement | null = null;
    let bookmark: ReturnType<typeof createSelectionBookmark> | null = null;
    let session = 0;
    let focusMode = false;
    let latexView = "source";
    let split = 50;
    const surface = document.getElementById("document-surface")!;
    document.getElementById("latex-preview")!.tabIndex = 0;
    const divider = document.createElement("div");
    divider.className = "latex-divider";
    divider.tabIndex = 0;
    divider.setAttribute("role", "separator");
    divider.setAttribute("aria-label", "Resize Source and PDF panes");
    divider.setAttribute("aria-orientation", "vertical");
    divider.setAttribute("aria-valuemin", "25");
    divider.setAttribute("aria-valuemax", "75");
    editor.after(divider);
    const resizeSplit = (value: number) => {
        split = Math.max(25, Math.min(75, value));
        surface.style.setProperty("--latex-source-width", `${split}%`);
        divider.setAttribute("aria-valuenow", String(Math.round(split)));
    };
    resizeSplit(split);
    divider.addEventListener("keydown", event => {
        if (event.isComposing) return;
        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            resizeSplit(event.key === "Home" ? 25 : event.key === "End" ? 75 : split + (event.key === "ArrowRight" ? 5 : -5));
        }
    });
    divider.addEventListener("pointerdown", event => {
        divider.setPointerCapture(event.pointerId);
        event.preventDefault();
        divider.focus();
    });
    divider.addEventListener("pointermove", event => {
        if (!divider.hasPointerCapture(event.pointerId)) return;
        const rect = surface.getBoundingClientRect();
        resizeSplit((event.clientX - rect.left) / rect.width * 100);
    });
    divider.addEventListener("pointerup", event => divider.releasePointerCapture(event.pointerId));

    function items(): Item[] {
        const native = canUseDesktopFileSystem();
        const markdown = documentState.activeFormatId === "markdown";
        const latex = documentState.activeFormatId === "latex";
        const result: Item[] = commands.filter(command => command.id !== "view:toggle-file-tree").map(command => ({
            id: command.id,
            label: command.id === "file:open-directory" ? "Open Folder" : command.label,
            group: command.group,
            shortcut: readShortcutLabel(command.id),
            enabled: command.editor ? options.inputController.canExecuteCommand(command.editor)
                : command.id === "file:export" ? Boolean(getActiveDocumentFormat().export)
                : command.id.startsWith("file:") ? (command.id === "file:new" || native)
                : command.id === "view:toggle-markdown-source" ? markdown
                : ["edit:undo", "edit:redo", "edit:cut", "edit:copy"].includes(command.id) ? options.inputController.canExecuteCommand(command.id.slice(5) as "undo" | "redo" | "cut" | "copy") : true,
            active: command.editor ? options.inputController.isCommandActive(command.editor) : command.id === "view:toggle-markdown-source" ? isMarkdownSourceMode() : undefined,
            run: () => { if (command.id === "file:open-directory") { open("files"); void options.fileTree.openDirectory().catch(error => note(String(error))); } else dispatchCommand(command.id); },
        }));
        for (const mode of ["Live Preview", "Source"]) result.push({ id: `markdown:${mode}`, label: `Markdown: ${mode}`, group: "View", enabled: markdown, active: markdown && isMarkdownSourceMode() === (mode === "Source"), run: () => { if (isMarkdownSourceMode() !== (mode === "Source")) toggleMarkdownEditingMode(); } });
        for (const mode of ["source", "split", "pdf"]) result.push({ id: `latex:${mode}`, label: `LaTeX: ${mode.toUpperCase() === "PDF" ? "PDF" : mode[0].toUpperCase() + mode.slice(1)}`, group: "View", enabled: latex && (mode !== "split" || window.innerWidth > 700), active: latex && latexView === mode, run: () => { latexView = mode; sync(); if (mode === "pdf") document.getElementById("latex-preview")?.focus(); } });
        result.push({ id: "latex:compile", label: "Save & Compile", group: "File", enabled: latex && native && !documentState.isSavingDocument, run: () => { void saveAndCompileLatex(() => saveCurrentDocument({ promptForPath: !documentState.activeFilePath })); } });
        result.push({ id: "ui:focus", label: focusMode ? "Exit Focus mode" : "Focus mode", group: "View", shortcut: readShortcutLabel("ui:focus"), enabled: true, active: focusMode, run: toggleFocus });
        result.push({ id: "ui:files", label: "Navigate Files", group: "Navigate", shortcut: readShortcutLabel("ui:files"), enabled: true, run: () => open("files") });
        result.push({ id: "ui:outline", label: "Navigate Outline", group: "Navigate", shortcut: readShortcutLabel("ui:outline"), enabled: true, run: () => open("outline") });
        return result;
    }
    function dispatchCommand(command: AppMenuCommand): void {
        window.dispatchEvent(new CustomEvent(appMenuCommandEvent, { detail: { command, focusOwner: editor } }));
    }
    function restoreSelection(): void {
        const selection = session === documentState.sessionId ? bookmark?.read() : null;
        if (selection) {
            dispatch({ changes: [], selection, annotations: { userEvent: "programmatic", addToHistory: false } });
            syncDomSelectionFromState({ focus: "editor" });
        }
    }
    function close(restore = true): void {
        if (panel.hidden) return;
        const previous = initiator;
        panel.hidden = true;
        kind = "";
        park();
        if (restore) {
            restoreSelection();
            if (previous?.isConnected && !editor.contains(previous) && previous !== editor) previous.focus({ preventScroll: true });
        }
        bookmark?.dispose();
        bookmark = null;
        nav.setAttribute("aria-expanded", "false");
    }
    function park(): void {
        parking.append(fileFrame, outline);
        options.fileTree.close();
        titleRow.hidden = true;
        titleHome.prepend(titleRow);
    }
    function open(next: string): void {
        if (panel.hidden) {
            initiator = document.activeElement instanceof HTMLElement ? document.activeElement : editor;
            bookmark ??= createSelectionBookmark();
            session = documentState.sessionId;
        }
        document.getElementById("find-close")?.click();
        kind = next;
        group = "";
        panel.hidden = false;
        panel.dataset.kind = next;
        render();
        const focusable = Array.from(panel.querySelectorAll<HTMLElement>("input, button:not(:disabled)")).filter(node => node.getClientRects().length > 0);
        (focusable.find(node => node instanceof HTMLInputElement) ?? focusable[0])?.focus({ preventScroll: true });
        nav.setAttribute("aria-expanded", String(["files", "outline", "commands"].includes(next)));
    }
    function render(): void {
        park();
        panel.replaceChildren();
        const top = document.createElement("div");
        top.className = "panel-top";
        const heading = document.createElement("strong");
        heading.textContent = kind === "commands" ? "All Commands" : kind === "details" ? "Document details" : kind === "actions" ? (group || "Actions") : "Navigate";
        panel.setAttribute("aria-label", heading.textContent);
        const closeButton = button("Close panel", () => close());
        closeButton.textContent = "\u00d7";
        closeButton.className = "frame-close";
        top.append(heading, closeButton);
        panel.append(top);
        if (["files", "outline", "commands"].includes(kind)) {
            panel.replaceChildren();
            renderExplorer(closeButton);
            return;
        }
        if (kind === "details") {
            note(documentState.activeFilePath || "No file path — this document has not been saved.");
            note(documentState.isSavingDocument ? "Saving…" : documentState.hasUnsavedChanges ? "Unsaved changes" : documentState.activeFilePath ? "Saved" : "Not saved to disk");
            if (documentState.activeFormatId === "latex") {
                note(`PDF: ${document.getElementById("latex-preview-status")?.textContent || document.getElementById("latex-preview")?.dataset.state || "Not loaded"}`);
            }
            panel.append(button("Rename", () => {
                titleRow.hidden = false;
                panel.append(titleRow);
                const input = document.getElementById("document-title") as HTMLInputElement;
                if (!panel.querySelector("[data-apply-rename]")) {
                    const apply = button("Apply Rename", () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
                    apply.dataset.applyRename = "true";
                    panel.append(apply);
                }
                input.focus(); input.select();
            }));
            return;
        }
        if (!group) {
            for (const id of ["edit:find", "edit:replace", "file:save", "file:save-as", "file:export", "latex:compile", "ui:focus"]) addItem(panel, items().find(item => item.id === id)!);
            for (const name of ["Formatting", "Insert", "Edit", "View", "File", "Help"]) {
                const submenu = button(`${name} ›`, () => { group = name; render(); panel.querySelector<HTMLElement>(".command-row")?.focus(); });
                submenu.setAttribute("aria-haspopup", "menu");
                panel.append(submenu);
            }
            panel.append(button("All Commands", () => open("commands")));
        } else {
            panel.append(button("Back to Actions", () => { group = ""; render(); panel.querySelector<HTMLElement>("button")?.focus(); }));
            const menu = document.createElement("div");
            menu.setAttribute("role", "menu");
            menu.setAttribute("aria-label", group);
            for (const item of items().filter(item => item.group === group)) addItem(menu, item);
            panel.append(menu);
        }
    }
    function renderExplorer(closeButton: HTMLButtonElement): void {
        const searchSurface = document.createElement("div");
        searchSurface.className = "explorer-search-surface";
        const search = document.createElement("input");
        search.id = "explorer-query";
        search.type = "text";
        search.setAttribute("role", "searchbox");
        search.autocomplete = "off";
        search.spellcheck = false;
        search.value = kind === "commands" ? ">" : kind === "outline" ? "@" : "";
        searchSurface.append(search, closeButton);
        const resultsSurface = document.createElement("div");
        resultsSurface.className = "explorer-results-surface";
        const modes = document.createElement("div");
        modes.className = "explorer-modes";
        modes.setAttribute("role", "tablist");
        modes.setAttribute("aria-label", "Explorer mode");
        const modeNames = ["files", "commands", "outline"];
        const selectMode = (mode: string) => {
            search.value = mode === "commands" ? ">" : mode === "outline" ? "@" : "";
            update();
            search.focus();
            search.setSelectionRange(search.value.length, search.value.length);
        };
        for (const mode of modeNames) {
            const control = button(mode[0].toUpperCase() + mode.slice(1), () => selectMode(mode));
            control.setAttribute("role", "tab");
            control.dataset.mode = mode;
            control.addEventListener("keydown", event => {
                if (event.isComposing || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
                event.preventDefault();
                const next = modeNames[(modeNames.indexOf(mode) + (event.key === "ArrowRight" ? 1 : 2)) % modeNames.length];
                selectMode(next);
                modes.querySelector<HTMLElement>(`[data-mode="${next}"]`)?.focus();
            });
            modes.append(control);
        }
        const results = document.createElement("div");
        results.className = "explorer-results";
        const shortcuts = document.createElement("div");
        shortcuts.className = "explorer-direct-actions";
        shortcuts.setAttribute("role", "group");
        shortcuts.setAttribute("aria-label", "Document actions");
        const openFile = button("Open File", () => { close(false); dispatchCommand("file:open"); });
        const openFolder = button("Open Folder", () => {
            search.value = "";
            update();
            void options.fileTree.openDirectory().then(() => {
                if (kind === "files") options.fileTree.setQuery(search.value);
            }).catch(error => noteResult(String(error)));
        });
        openFile.disabled = openFolder.disabled = !canUseDesktopFileSystem();
        shortcuts.append(openFile, openFolder, button("Document details", () => open("details")));
        resultsSurface.append(modes, results, shortcuts);
        panel.append(searchSurface, resultsSurface);
        const noteResult = (text: string) => {
            const message = document.createElement("p");
            message.textContent = text;
            results.append(message);
        };
        function update(): void {
            const previousKind = kind;
            if (search.value.startsWith(">")) kind = "commands";
            else if (search.value.startsWith("@")) kind = "outline";
            else kind = "files";
            if (kind !== previousKind) results.scrollTop = 0;
            const query = (kind === "files" ? search.value : search.value.slice(1)).trim();
            panel.dataset.kind = kind;
            panel.setAttribute("aria-label", kind === "commands" ? "All Commands" : kind === "outline" ? "Outline" : "Files");
            search.placeholder = kind === "commands" ? "Search commands" : kind === "outline" ? "Search headings" : "Search files";
            search.setAttribute("aria-label", search.placeholder);
            modes.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach(control => {
                const selected = control.dataset.mode === kind;
                control.setAttribute("aria-selected", String(selected));
                control.tabIndex = selected ? 0 : -1;
            });
            parking.append(fileFrame, outline);
            if (kind !== "files") options.fileTree.close();
            results.replaceChildren();
            if (kind === "commands") {
                renderItems(results, query);
            } else if (kind === "outline") {
                results.append(outline);
                const headings = Array.from(outline.querySelectorAll<HTMLElement>("li"));
                headings.forEach(item => item.hidden = !item.textContent?.toLowerCase().includes(query.toLowerCase()));
                if (!headings.length) noteResult(documentState.activeFormatId !== "markdown" || isMarkdownSourceMode()
                    ? "Headings are available in Markdown Live Preview."
                    : "No headings yet. Add a Markdown heading to build an outline.");
                else if (headings.every(item => item.hidden)) noteResult("No matching headings.");
            } else {
                results.append(fileFrame);
                options.fileTree.show();
                options.fileTree.setQuery(query);
                if (!canUseDesktopFileSystem()) {
                    fileFrame.querySelectorAll<HTMLButtonElement>("[data-file-tree-open-directory]").forEach(button => button.disabled = true);
                    noteResult("File and folder dialogs are available in the desktop app.");
                }
            }
        }
        search.addEventListener("input", event => { if (!(event as InputEvent).isComposing) update(); });
        search.addEventListener("compositionend", update);
        search.addEventListener("keydown", event => {
            if (event.isComposing || !["ArrowDown", "Enter"].includes(event.key)) return;
            const candidates = Array.from(results.querySelectorAll<HTMLButtonElement>(kind === "files" ? "[data-file-tree-selectable=\"true\"]" : "button:not(:disabled)")).filter(button => button.getClientRects().length > 0);
            const first = (kind === "files" ? candidates.find(button => button.dataset.selected === "true") : null) ?? candidates[0];
            if (!first) return;
            event.preventDefault();
            if (event.key === "Enter") first.click(); else first.focus();
        });
        update();
    }
    function note(text: string): void { const p = document.createElement("p"); p.textContent = text; panel.append(p); }
    function renderItems(root: HTMLElement, query: string): void {
        root.replaceChildren();
        let previousGroup = "";
        for (const item of items().filter(item => `${item.label} ${item.group}`.toLowerCase().includes(query.toLowerCase())).sort((a,b) => a.group.localeCompare(b.group))) {
            if (previousGroup !== item.group) { const label = document.createElement("h3"); label.textContent = item.group; root.append(label); previousGroup = item.group; }
            addItem(root, item);
        }
        if (!root.childElementCount) root.textContent = "No matching commands.";
    }
    function addItem(root: HTMLElement, item: Item): void {
        const control = button(item.label, () => { restoreSelection(); close(false); item.run(); });
        control.className = "command-row";
        control.disabled = !item.enabled;
        control.dataset.command = item.id;
        control.removeAttribute("aria-label");
        control.title = item.enabled ? item.label : `${item.label} — unavailable in this document or environment`;
        if (root.getAttribute("role") === "menu") control.setAttribute("role", item.active === undefined ? "menuitem" : "menuitemcheckbox");
        if (item.active !== undefined) {
            control.setAttribute(root.getAttribute("role") === "menu" ? "aria-checked" : "aria-pressed", String(item.active));
            if (item.active) control.prepend(document.createTextNode("\u2713 "));
        }
        if (item.shortcut) { const key = document.createElement("kbd"); key.textContent = item.shortcut; control.append(key); }
        root.append(control);
    }
    function toggleFocus(): void {
        close();
        document.getElementById("find-close")?.click();
        focusMode = !focusMode;
        document.body.classList.toggle("writing-focus", focusMode);
        exit.hidden = !focusMode;
        syncDomSelectionFromState({ focus: "editor" });
    }
    function sync(): void {
        filename.textContent = documentState.fileName;
        unsaved.hidden = !documentState.hasUnsavedChanges;
        nav.title = `${documentState.activeFilePath || documentState.fileName}${documentState.hasUnsavedChanges ? " ? Unsaved changes" : ""}\nOpen files, commands and outline`;
        nav.setAttribute("aria-description", `${documentState.fileName}${documentState.hasUnsavedChanges ? ", unsaved changes" : ""}`);
        surface.dataset.latexView = latexView;
        if (documentState.activeFormatId === "latex" && latexView === "split" && window.innerWidth <= 700) {
            latexView = "source";
            surface.dataset.latexView = latexView;
        }
    }
    header.addEventListener("pointerdown", event => {
        // Keep the source selection intact until the panel has captured a bookmark.
        if (panel.hidden && (event.target as Element).closest("button")) {
            bookmark?.dispose();
            bookmark = createSelectionBookmark();
            session = documentState.sessionId;
        }
    });
    document.addEventListener("pointerdown", event => {
        if (!panel.hidden && !panel.contains(event.target as Node) && !header.contains(event.target as Node)) close();
        const find = document.getElementById("find-replace-panel")!;
        if (!find.hidden && !find.contains(event.target as Node) && !header.contains(event.target as Node)) document.getElementById("find-close")?.click();
    });
    window.addEventListener("glyph:navigation-selected", () => close(false));
    window.addEventListener(documentStateChangedEvent, sync);
    window.addEventListener("resize", sync);
    document.addEventListener("keydown", event => {
        if (event.isComposing || event.defaultPrevented) return;
        const command = readShortcutCommand(event, "global");
        if (["ui:commands", "ui:files", "ui:outline", "ui:focus", "view:toggle-file-tree"].includes(command ?? "")) {
            event.preventDefault(); event.stopImmediatePropagation();
            if (command === "ui:focus") toggleFocus(); else open(command === "ui:commands" ? "commands" : command === "ui:outline" ? "outline" : "files");
            return;
        }
        if (!panel.hidden && command && ["edit:find", "edit:replace", "view:toggle-markdown-source"].includes(command)) {
            restoreSelection(); close(false);
        }
        if (event.key === "F6") {
            event.preventDefault();
            const regions = [header.querySelector<HTMLElement>("button"), !panel.hidden ? panel.querySelector<HTMLElement>("input,button") : null, !document.getElementById("find-replace-panel")!.hidden ? document.getElementById("find-query") : null, editor, documentState.activeFormatId === "latex" && latexView !== "source" ? document.getElementById("latex-preview") : null, focusMode ? exit : null].filter((node): node is HTMLElement => !!node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden");
            const active = document.activeElement;
            const current = regions.findIndex(node => node === editor ? editor.contains(active)
                : node === regions[0] && header.contains(node) ? header.contains(active)
                : node.closest(".writing-panel") ? panel.contains(active)
                : node.closest("#find-replace-panel") ? document.getElementById("find-replace-panel")!.contains(active)
                : node === active);
            const target = regions[(current + (event.shiftKey ? -1 : 1) + regions.length) % regions.length];
            if (target === editor) syncDomSelectionFromState({ focus: "editor" }); else target?.focus();
            return;
        }
        if (panel.hidden) return;
        if (event.key === "Escape") {
            if (event.target === document.getElementById("document-title")) return; event.preventDefault(); event.stopImmediatePropagation(); close(); return; }
        if (!panel.contains(event.target as Node) || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && !(event.target as Element).closest(".file-tree")) {
            event.preventDefault(); event.stopPropagation();
            // Result navigation stays in its list; Tab reaches tabs, close and file actions.
            const region = (event.target as Element).closest(".explorer-results") ?? panel;
            const controls = Array.from(region.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")).filter(node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden");
            const index = controls.indexOf(document.activeElement as HTMLButtonElement);
            controls[event.key === "Home" ? 0 : event.key === "End" ? controls.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + controls.length) % controls.length]?.focus();
        }
    }, true);
    sync();
}
function button(label: string, action: () => void): HTMLButtonElement {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    element.setAttribute("aria-label", label);
    element.title = label;
    element.addEventListener("click", action);
    return element;
}

