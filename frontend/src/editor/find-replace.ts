import { getElement } from "../utils/dom";
import { sourceOffsetToDomPoint, syncDomSelectionFromState, syncStateSelectionFromDom } from "./core/projection";
import { dispatch, getEditorState } from "./core/store";

export type FindReplaceController = {
    openFind: () => void;
    openReplace: () => void;
    close: () => void;
    refresh: () => void;
};

type FindMatch = { from: number; to: number };
type FindOptions = { caseSensitive: boolean; wholeWord: boolean };
type FindReplaceElements = {
    panel: HTMLElement;
    findInput: HTMLInputElement;
    replaceInput: HTMLInputElement;
    counter: HTMLElement;
    previousButton: HTMLButtonElement;
    nextButton: HTMLButtonElement;
    caseButton: HTMLButtonElement;
    wholeWordButton: HTMLButtonElement;
    replaceToggleButton: HTMLButtonElement;
    replaceButton: HTMLButtonElement;
    replaceAllButton: HTMLButtonElement;
    closeButton: HTMLButtonElement;
    highlightLayer: HTMLElement;
    replaceRow: HTMLElement;
};

const wordCharacterPattern = /[\p{L}\p{N}_]/u;

export function installFindReplaceController(options: {
    editor: HTMLElement;
    shell: HTMLElement;
}): FindReplaceController {
    const elements = readElements();
    let matches: FindMatch[] = [];
    let activeIndex = -1;
    let findOptions: FindOptions = { caseSensitive: false, wholeWord: false };
    let highlightFrame = 0;

    elements.findInput.addEventListener("input", () => scan());
    elements.findInput.addEventListener("keydown", handleFindKeydown);
    elements.replaceInput.addEventListener("keydown", handleReplaceKeydown);
    elements.previousButton.addEventListener("click", () => navigate(-1));
    elements.nextButton.addEventListener("click", () => navigate(1));
    elements.caseButton.addEventListener("click", () => {
        findOptions.caseSensitive = !findOptions.caseSensitive;
        scan();
    });
    elements.wholeWordButton.addEventListener("click", () => {
        findOptions.wholeWord = !findOptions.wholeWord;
        scan();
    });
    elements.replaceToggleButton.addEventListener("click", () => setReplaceExpanded(elements.replaceRow.hidden === true));
    elements.replaceButton.addEventListener("click", replaceCurrent);
    elements.replaceAllButton.addEventListener("click", replaceAll);
    elements.closeButton.addEventListener("click", close);
    options.shell.addEventListener("scroll", scheduleHighlights);
    options.editor.addEventListener("scroll", scheduleHighlights);
    window.addEventListener("resize", scheduleHighlights);

    syncControls();
    return { openFind, openReplace, close, refresh };

    function openFind(): void {
        open(false);
    }

    function openReplace(): void {
        open(true);
    }

    function open(replace: boolean): void {
        syncStateSelectionFromDom();
        seedQueryFromSelection();
        elements.panel.hidden = false;
        setReplaceExpanded(replace);
        scan();
        const input = replace ? elements.replaceInput : elements.findInput;
        input.focus();
        input.select();
    }

    function close(): void {
        elements.panel.hidden = true;
        elements.highlightLayer.replaceChildren();
        options.editor.focus();
        syncDomSelectionFromState();
    }

    function refresh(): void {
        if (!elements.panel.hidden) {
            scan(false);
        }
    }

    function scan(chooseFromSelection = true): void {
        matches = collectMatches(getEditorState().doc, elements.findInput.value, findOptions);
        if (matches.length === 0) {
            activeIndex = -1;
        } else if (chooseFromSelection) {
            const head = getEditorState().selection.head;
            const next = matches.findIndex((match) => match.from >= head);
            activeIndex = next >= 0 ? next : 0;
        } else {
            activeIndex = Math.min(Math.max(0, activeIndex), matches.length - 1);
        }
        syncControls();
        scheduleHighlights();
    }

    function navigate(delta: -1 | 1): void {
        if (matches.length === 0) return;
        activeIndex = (activeIndex + delta + matches.length) % matches.length;
        focusMatch(matches[activeIndex]);
        syncControls();
        scheduleHighlights();
    }

    function focusMatch(match: FindMatch): void {
        dispatch({
            changes: [],
            selection: { anchor: match.from, head: match.to },
            annotations: { userEvent: "programmatic", addToHistory: false },
        });
        syncDomSelectionFromState();
        const point = sourceOffsetToDomPoint(match.from);
        const element = point.node instanceof Element ? point.node : point.node.parentElement;
        element?.scrollIntoView({ block: "center" });
    }

    function replaceCurrent(): void {
        const match = matches[activeIndex];
        if (!match) return;
        const insert = elements.replaceInput.value;
        dispatch({
            changes: [{ from: match.from, to: match.to, insert }],
            selection: { anchor: match.from + insert.length, head: match.from + insert.length },
            annotations: { userEvent: "input", historyMode: "discrete" },
        });
        scan();
    }

    function replaceAll(): void {
        if (matches.length === 0) return;
        const insert = elements.replaceInput.value;
        const first = matches[0].from;
        dispatch({
            changes: matches.map((match) => ({ from: match.from, to: match.to, insert })),
            selection: { anchor: first + insert.length, head: first + insert.length },
            annotations: { userEvent: "input", historyMode: "discrete" },
        });
        scan();
    }

    function handleFindKeydown(event: KeyboardEvent): void {
        if (event.key === "Escape") {
            event.preventDefault();
            close();
        } else if (event.key === "Enter") {
            event.preventDefault();
            navigate(event.shiftKey ? -1 : 1);
        }
    }

    function handleReplaceKeydown(event: KeyboardEvent): void {
        if (event.key === "Escape") {
            event.preventDefault();
            close();
        } else if (event.key === "Enter") {
            event.preventDefault();
            replaceCurrent();
        }
    }

    function setReplaceExpanded(expanded: boolean): void {
        elements.replaceRow.hidden = !expanded;
        elements.panel.dataset.replaceExpanded = String(expanded);
        elements.replaceToggleButton.setAttribute("aria-expanded", String(expanded));
    }

    function syncControls(): void {
        elements.counter.textContent = matches.length === 0 ? "0 / 0" : `${activeIndex + 1} / ${matches.length}`;
        elements.caseButton.setAttribute("aria-pressed", String(findOptions.caseSensitive));
        elements.wholeWordButton.setAttribute("aria-pressed", String(findOptions.wholeWord));
        const disabled = matches.length === 0;
        elements.previousButton.disabled = disabled;
        elements.nextButton.disabled = disabled;
        elements.replaceButton.disabled = disabled;
        elements.replaceAllButton.disabled = disabled;
    }

    function scheduleHighlights(): void {
        if (highlightFrame) return;
        highlightFrame = window.requestAnimationFrame(() => {
            highlightFrame = 0;
            drawHighlights();
        });
    }

    function drawHighlights(): void {
        elements.highlightLayer.replaceChildren();
        if (elements.panel.hidden) return;
        const highlights: HTMLElement[] = [];
        matches.forEach((match, index) => {
            const start = sourceOffsetToDomPoint(match.from, { activateSourceTokens: false });
            const end = sourceOffsetToDomPoint(match.to, { activateSourceTokens: false });
            const range = document.createRange();
            try {
                range.setStart(start.node, start.offset);
                range.setEnd(end.node, end.offset);
            } catch {
                return;
            }
            for (const rect of Array.from(range.getClientRects())) {
                if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) continue;
                const highlight = document.createElement("div");
                highlight.className = "find-highlight-rect";
                highlight.style.left = `${rect.left}px`;
                highlight.style.top = `${rect.top}px`;
                highlight.style.width = `${Math.max(1, rect.width)}px`;
                highlight.style.height = `${Math.max(1, rect.height)}px`;
                if (index === activeIndex) highlight.dataset.active = "true";
                highlights.push(highlight);
            }
        });
        elements.highlightLayer.append(...highlights);
    }

    function seedQueryFromSelection(): void {
        const state = getEditorState();
        const from = Math.min(state.selection.anchor, state.selection.head);
        const to = Math.max(state.selection.anchor, state.selection.head);
        if (from !== to) {
            const selected = state.doc.slice(from, to);
            if (!selected.includes("\n")) elements.findInput.value = selected;
        }
    }
}

function collectMatches(source: string, query: string, options: FindOptions): FindMatch[] {
    if (!query) return [];
    const haystack = options.caseSensitive ? source : source.toLocaleLowerCase();
    const needle = options.caseSensitive ? query : query.toLocaleLowerCase();
    const matches: FindMatch[] = [];
    let from = 0;
    while (from <= haystack.length - needle.length) {
        const index = haystack.indexOf(needle, from);
        if (index < 0) break;
        const to = index + needle.length;
        if (!options.wholeWord || isWholeWord(source, index, to)) matches.push({ from: index, to });
        from = Math.max(to, index + 1);
    }
    return matches;
}

function isWholeWord(source: string, from: number, to: number): boolean {
    return !wordCharacterPattern.test(source[from - 1] ?? "") && !wordCharacterPattern.test(source[to] ?? "");
}

function readElements(): FindReplaceElements {
    return {
        panel: getElement("find-replace-panel"),
        findInput: getElement("find-query"),
        replaceInput: getElement("replace-query"),
        counter: getElement("find-counter"),
        previousButton: getElement("find-previous"),
        nextButton: getElement("find-next"),
        caseButton: getElement("find-case-sensitive"),
        wholeWordButton: getElement("find-whole-word"),
        replaceToggleButton: getElement("find-replace-toggle"),
        replaceButton: getElement("replace-current"),
        replaceAllButton: getElement("replace-all"),
        closeButton: getElement("find-close"),
        highlightLayer: getElement("find-highlight-layer"),
        replaceRow: getElement("replace-row"),
    };
}
