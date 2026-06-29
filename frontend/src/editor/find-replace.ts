import { getElement } from "../utils/dom";
import {
    findBlock,
    getBlockContent,
    getBlockIndex,
    getBlockText,
    getEditorBlocks,
    setBlockText,
} from "./blocks/view";
import {
    focusBlockAtOffset,
    getCaretOffset,
    getSelectedBlockRange,
    getTextPosition,
} from "./selection/caret";
import {
    beginDiscreteUndoTransaction,
    commitUndoTransaction,
} from "./history/undo-history";

export type FindReplaceController = {
    openFind: () => void;
    openReplace: () => void;
    close: () => void;
    refresh: () => void;
};

type FindOptions = {
    caseSensitive: boolean;
    wholeWord: boolean;
};

type FindMatch = {
    block: HTMLElement;
    blockIndex: number;
    startOffset: number;
    endOffset: number;
};

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
};

type SearchPoint = {
    blockIndex: number;
    offset: number;
};

type TextInputSelection = {
    start: number | null;
    end: number | null;
    direction: "forward" | "backward" | "none";
};

type InstallFindReplaceOptions = {
    editor: HTMLElement;
    shell: HTMLElement;
    onDirty: () => void;
};

const wholeWordCharacterPattern = /[\p{L}\p{N}_]/u;

export function installFindReplaceController({
    editor,
    shell,
    onDirty,
}: InstallFindReplaceOptions): FindReplaceController {
    const elements = readFindReplaceElements();
    const replaceRow = getElement<HTMLElement>("replace-row");
    let matches: FindMatch[] = [];
    let activeMatchIndex = -1;
    let lastQuery = "";
    let options: FindOptions = { caseSensitive: false, wholeWord: false };
    let lastSearchAnchor: SearchPoint | null = null;
    let highlightFrame = 0;

    elements.findInput.addEventListener("input", () => {
        scanFromCurrentAnchor();
    });
    elements.findInput.addEventListener("keydown", handleFindInputKeydown);
    elements.replaceInput.addEventListener("keydown", handleReplaceInputKeydown);
    elements.previousButton.addEventListener("click", () => navigateMatches(-1));
    elements.nextButton.addEventListener("click", () => navigateMatches(1));
    elements.caseButton.addEventListener("click", () => toggleCaseSensitive());
    elements.wholeWordButton.addEventListener("click", () => toggleWholeWord());
    elements.replaceToggleButton.addEventListener("click", () => {
        setReplaceExpanded(replaceRow.hidden === true);
        if (!replaceRow.hidden) {
            elements.replaceInput.focus();
            elements.replaceInput.select();
        }
    });
    elements.replaceButton.addEventListener("click", () => replaceCurrentMatch());
    elements.replaceAllButton.addEventListener("click", () => replaceAllMatches());
    elements.closeButton.addEventListener("click", () => close());
    editor.addEventListener("input", () => refresh());
    editor.addEventListener("change", () => refresh());
    shell.addEventListener("scroll", () => scheduleHighlightRedraw());
    editor.addEventListener("scroll", () => scheduleHighlightRedraw());
    window.addEventListener("resize", () => scheduleHighlightRedraw());
    document.addEventListener("keydown", handleDocumentKeydown, true);

    syncControls();

    return {
        openFind,
        openReplace,
        close,
        refresh,
    };

    function openFind(): void {
        openPanel(false);
    }

    function openReplace(): void {
        openPanel(true);
    }

    function close(): void {
        if (elements.panel.hidden) {
            return;
        }

        const activeMatch = getActiveMatch();
        elements.panel.hidden = true;
        clearHighlights();

        if (activeMatch && selectMatch(activeMatch, { scroll: false })) {
            return;
        }

        editor.focus();
    }

    function refresh(): void {
        if (elements.panel.hidden) {
            clearHighlights();
            return;
        }

        const activeMatch = getActiveMatch();
        scanMatches(activeMatch ? matchStartPoint(activeMatch) : lastSearchAnchor, true);
    }

    function openPanel(expandReplace: boolean): void {
        lastSearchAnchor = readEditorSelectionPoint() ?? readActiveMatchPoint() ?? lastSearchAnchor;
        seedFindInputFromSelection();
        elements.panel.hidden = false;
        setReplaceExpanded(expandReplace);
        scanMatches(lastSearchAnchor, true);
        elements.findInput.focus();
        elements.findInput.select();
    }

    function handleFindInputKeydown(event: KeyboardEvent): void {
        if (event.key !== "Enter") {
            return;
        }

        event.preventDefault();
        navigateMatches(event.shiftKey ? -1 : 1, elements.findInput);
    }

    function handleReplaceInputKeydown(event: KeyboardEvent): void {
        if (event.key !== "Enter") {
            return;
        }

        event.preventDefault();
        if (event.ctrlKey || event.metaKey) {
            replaceAllMatches();
        } else {
            replaceCurrentMatch();
        }
        restoreTextInputFocus(elements.replaceInput);
    }

    function handleDocumentKeydown(event: KeyboardEvent): void {
        if (elements.panel.hidden) {
            return;
        }

        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
            return;
        }

        if (event.key === "Enter" && shouldRouteEditorEnterToFind(event)) {
            event.preventDefault();
            event.stopPropagation();
            navigateMatches(event.shiftKey ? -1 : 1, elements.findInput);
        }
    }

    function toggleCaseSensitive(): void {
        options = { ...options, caseSensitive: !options.caseSensitive };
        elements.caseButton.setAttribute("aria-pressed", options.caseSensitive ? "true" : "false");
        scanFromCurrentAnchor();
    }

    function toggleWholeWord(): void {
        options = { ...options, wholeWord: !options.wholeWord };
        elements.wholeWordButton.setAttribute("aria-pressed", options.wholeWord ? "true" : "false");
        scanFromCurrentAnchor();
    }

    function scanFromCurrentAnchor(): void {
        scanMatches(readEditorSelectionPoint() ?? readActiveMatchPoint() ?? lastSearchAnchor, false);
    }

    function scanMatches(targetPoint: SearchPoint | null, keepActiveWhenPossible: boolean): void {
        const query = elements.findInput.value;
        const previousMatch = getActiveMatch();

        lastQuery = query;
        matches = query ? collectMatches(query, options) : [];

        if (matches.length === 0) {
            activeMatchIndex = -1;
        } else if (keepActiveWhenPossible && previousMatch) {
            activeMatchIndex = findSameMatchIndex(previousMatch);
            if (activeMatchIndex < 0) {
                activeMatchIndex = findMatchIndexAtOrAfter(targetPoint ?? matchStartPoint(previousMatch));
            }
        } else {
            activeMatchIndex = findMatchIndexAtOrAfter(targetPoint);
        }

        if (targetPoint) {
            lastSearchAnchor = targetPoint;
        }

        syncControls();
        scheduleHighlightRedraw();
    }

    function navigateMatches(direction: 1 | -1, restoreFocusTarget: HTMLInputElement | null = null): void {
        const inputSelection = restoreFocusTarget ? readTextInputSelection(restoreFocusTarget) : null;

        if (!lastQuery || matches.length === 0) {
            scanFromCurrentAnchor();
        }

        if (matches.length === 0) {
            if (restoreFocusTarget) {
                restoreTextInputFocus(restoreFocusTarget, inputSelection);
            }
            return;
        }

        activeMatchIndex = activeMatchIndex < 0
            ? (direction > 0 ? 0 : matches.length - 1)
            : (activeMatchIndex + direction + matches.length) % matches.length;

        syncControls();
        const activeMatch = getActiveMatch();
        if (activeMatch) {
            lastSearchAnchor = matchStartPoint(activeMatch);
            selectMatch(activeMatch, { scroll: true });
        }

        if (restoreFocusTarget) {
            restoreTextInputFocus(restoreFocusTarget, inputSelection);
        }
    }

    function replaceCurrentMatch(): void {
        const match = readValidActiveMatch();
        if (!match) {
            return;
        }

        const replacement = elements.replaceInput.value;
        const text = getBlockText(match.block);
        const nextText = text.slice(0, match.startOffset) + replacement + text.slice(match.endOffset);
        const nextPoint = {
            blockIndex: match.blockIndex,
            offset: match.startOffset + replacement.length,
        };

        if (nextText !== text) {
            beginDiscreteUndoTransaction();
            setBlockText(match.block, nextText);
            focusBlockAtReplacementEnd(match.block, nextPoint.offset);
            commitUndoTransaction();
            onDirty();
        } else {
            focusBlockAtReplacementEnd(match.block, nextPoint.offset);
        }

        scanMatches(nextPoint, false);
        const nextMatch = getActiveMatch();
        if (nextMatch) {
            selectMatch(nextMatch, { scroll: true });
        }
    }

    function replaceAllMatches(): void {
        if (!lastQuery) {
            return;
        }

        matches = collectMatches(lastQuery, options);
        if (matches.length === 0) {
            activeMatchIndex = -1;
            syncControls();
            scheduleHighlightRedraw();
            return;
        }

        const replacement = elements.replaceInput.value;
        const matchesByBlock = groupMatchesByBlock(matches);
        let changed = false;

        beginDiscreteUndoTransaction();
        for (const [block, blockMatches] of Array.from(matchesByBlock.entries())) {
            let text = getBlockText(block);
            for (const match of blockMatches.slice().reverse()) {
                text = text.slice(0, match.startOffset) + replacement + text.slice(match.endOffset);
            }

            if (text !== getBlockText(block)) {
                setBlockText(block, text);
                changed = true;
            }
        }
        commitUndoTransaction();

        if (changed) {
            onDirty();
        }

        scanMatches(null, false);
        elements.replaceInput.focus();
        elements.replaceInput.select();
    }

    function readValidActiveMatch(): FindMatch | null {
        let match = getActiveMatch();
        if (match && isMatchStillValid(match, lastQuery, options)) {
            return match;
        }

        scanMatches(match ? matchStartPoint(match) : lastSearchAnchor, false);
        match = getActiveMatch();
        return match && isMatchStillValid(match, lastQuery, options) ? match : null;
    }

    function selectMatch(match: FindMatch, selectOptions: { scroll: boolean }): boolean {
        const range = createRangeForMatch(match);
        const selection = document.getSelection();
        if (!range || !selection) {
            return false;
        }

        editor.focus();
        selection.removeAllRanges();
        selection.addRange(range);

        if (selectOptions.scroll) {
            match.block.scrollIntoView({ block: "center", inline: "nearest" });
        }

        scheduleHighlightRedraw();
        window.requestAnimationFrame(() => scheduleHighlightRedraw());
        return true;
    }

    function syncControls(): void {
        const hasMatches = matches.length > 0;

        elements.counter.textContent = hasMatches ? `${activeMatchIndex + 1} / ${matches.length}` : "0 / 0";
        elements.previousButton.disabled = !hasMatches;
        elements.nextButton.disabled = !hasMatches;
        elements.replaceButton.disabled = !hasMatches;
        elements.replaceAllButton.disabled = !hasMatches;
        elements.caseButton.setAttribute("aria-pressed", options.caseSensitive ? "true" : "false");
        elements.wholeWordButton.setAttribute("aria-pressed", options.wholeWord ? "true" : "false");
    }

    function setReplaceExpanded(expanded: boolean): void {
        replaceRow.hidden = !expanded;
        elements.panel.dataset.replaceExpanded = expanded ? "true" : "false";
        elements.replaceToggleButton.setAttribute("aria-expanded", expanded ? "true" : "false");
        elements.replaceToggleButton.setAttribute("aria-label", expanded ? "Hide replace" : "Show replace");
    }

    function scheduleHighlightRedraw(): void {
        if (elements.panel.hidden) {
            clearHighlights();
            return;
        }

        if (highlightFrame) {
            return;
        }

        highlightFrame = window.requestAnimationFrame(() => {
            highlightFrame = 0;
            renderHighlights();
        });
    }

    function renderHighlights(): void {
        elements.highlightLayer.replaceChildren();
        if (!lastQuery || matches.length === 0) {
            return;
        }

        const fragments: HTMLElement[] = [];
        for (let index = 0; index < matches.length; index += 1) {
            const range = createRangeForMatch(matches[index]);
            if (!range) {
                continue;
            }

            for (const rect of Array.from(range.getClientRects())) {
                if ((rect.width <= 0 && rect.height <= 0) || isRectOutsideViewport(rect)) {
                    continue;
                }

                fragments.push(createHighlightRect(rect, index === activeMatchIndex));
            }
        }

        elements.highlightLayer.replaceChildren(...fragments);
    }

    function clearHighlights(): void {
        if (highlightFrame) {
            window.cancelAnimationFrame(highlightFrame);
            highlightFrame = 0;
        }
        elements.highlightLayer.replaceChildren();
    }

    function findSameMatchIndex(match: FindMatch): number {
        return matches.findIndex(
            (candidate) =>
                candidate.block === match.block &&
                candidate.startOffset === match.startOffset &&
                candidate.endOffset === match.endOffset,
        );
    }

    function findMatchIndexAtOrAfter(point: SearchPoint | null): number {
        if (matches.length === 0) {
            return -1;
        }

        if (!point) {
            return 0;
        }

        const index = matches.findIndex(
            (match) => match.blockIndex > point.blockIndex ||
                (match.blockIndex === point.blockIndex && match.startOffset >= point.offset),
        );

        return index >= 0 ? index : 0;
    }

    function getActiveMatch(): FindMatch | null {
        return activeMatchIndex >= 0 ? matches[activeMatchIndex] ?? null : null;
    }

    function readActiveMatchPoint(): SearchPoint | null {
        const activeMatch = getActiveMatch();
        return activeMatch ? matchStartPoint(activeMatch) : null;
    }

    function shouldRouteEditorEnterToFind(event: KeyboardEvent): boolean {
        const target = event.target;
        if (!(target instanceof Node) || target === elements.findInput || target === elements.replaceInput) {
            return false;
        }

        if (!editor.contains(target) || event.ctrlKey || event.metaKey || event.altKey) {
            return false;
        }

        const activeMatch = getActiveMatch();
        const selectedRange = getSelectedBlockRange();
        return Boolean(
            activeMatch &&
                selectedRange &&
                selectedRange.startBlock === activeMatch.block &&
                selectedRange.endBlock === activeMatch.block &&
                selectedRange.startOffset === activeMatch.startOffset &&
                selectedRange.endOffset === activeMatch.endOffset,
        );
    }
}

function collectMatches(query: string, options: FindOptions): FindMatch[] {
    const blocks = getEditorBlocks();
    const needle = options.caseSensitive ? query : query.toLowerCase();
    const nextMatches: FindMatch[] = [];

    if (!needle) {
        return nextMatches;
    }

    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
        const block = blocks[blockIndex];
        const text = getBlockText(block);
        const haystack = options.caseSensitive ? text : text.toLowerCase();
        let start = haystack.indexOf(needle);

        while (start >= 0) {
            const end = start + query.length;
            if (!options.wholeWord || isWholeWordMatch(text, start, end)) {
                nextMatches.push({ block, blockIndex, startOffset: start, endOffset: end });
            }

            start = haystack.indexOf(needle, Math.max(start + query.length, start + 1));
        }
    }

    return nextMatches;
}

function readFindReplaceElements(): FindReplaceElements {
    return {
        panel: getElement<HTMLElement>("find-replace-panel"),
        findInput: getElement<HTMLInputElement>("find-query"),
        replaceInput: getElement<HTMLInputElement>("replace-query"),
        counter: getElement<HTMLElement>("find-counter"),
        previousButton: getElement<HTMLButtonElement>("find-previous"),
        nextButton: getElement<HTMLButtonElement>("find-next"),
        caseButton: getElement<HTMLButtonElement>("find-case-sensitive"),
        wholeWordButton: getElement<HTMLButtonElement>("find-whole-word"),
        replaceToggleButton: getElement<HTMLButtonElement>("find-replace-toggle"),
        replaceButton: getElement<HTMLButtonElement>("replace-current"),
        replaceAllButton: getElement<HTMLButtonElement>("replace-all"),
        closeButton: getElement<HTMLButtonElement>("find-close"),
        highlightLayer: getElement<HTMLElement>("find-highlight-layer"),
    };
}

function seedFindInputFromSelection(): void {
    const selectedRange = getSelectedBlockRange();
    if (!selectedRange || selectedRange.startBlock !== selectedRange.endBlock) {
        return;
    }

    const selectedText = getBlockText(selectedRange.startBlock).slice(selectedRange.startOffset, selectedRange.endOffset);
    if (!selectedText || selectedText.includes("\n")) {
        return;
    }

    getElement<HTMLInputElement>("find-query").value = selectedText;
}

function readEditorSelectionPoint(): SearchPoint | null {
    const selection = document.getSelection();
    const focusNode = selection?.focusNode;
    const block = findBlock(focusNode ?? null);
    if (!selection || !focusNode || !block) {
        return null;
    }

    return {
        blockIndex: getBlockIndex(block),
        offset: getCaretOffset(getBlockContent(block), focusNode, selection.focusOffset),
    };
}

function readTextInputSelection(input: HTMLInputElement): TextInputSelection {
    return {
        start: input.selectionStart,
        end: input.selectionEnd,
        direction: input.selectionDirection ?? "none",
    };
}

function restoreTextInputFocus(input: HTMLInputElement, selection: TextInputSelection | null = readTextInputSelection(input)): void {
    input.focus();
    if (selection && selection.start !== null && selection.end !== null) {
        input.setSelectionRange(selection.start, selection.end, selection.direction);
    }
}

function createRangeForMatch(match: FindMatch): Range | null {
    if (!match.block.isConnected) {
        return null;
    }

    const content = getBlockContent(match.block);
    const start = getTextPosition(content, match.startOffset);
    const end = getTextPosition(content, match.endOffset);
    const range = document.createRange();

    try {
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
    } catch {
        return null;
    }

    return range;
}

function isMatchStillValid(match: FindMatch, query: string, options: FindOptions): boolean {
    if (!query || !match.block.isConnected) {
        return false;
    }

    const text = getBlockText(match.block);
    if (match.endOffset > text.length) {
        return false;
    }

    const actual = text.slice(match.startOffset, match.endOffset);
    const matchesQuery = options.caseSensitive
        ? actual === query
        : actual.toLowerCase() === query.toLowerCase();

    return matchesQuery && (!options.wholeWord || isWholeWordMatch(text, match.startOffset, match.endOffset));
}

function groupMatchesByBlock(matches: FindMatch[]): Map<HTMLElement, FindMatch[]> {
    const grouped = new Map<HTMLElement, FindMatch[]>();
    for (const match of matches) {
        const blockMatches = grouped.get(match.block) ?? [];
        blockMatches.push(match);
        grouped.set(match.block, blockMatches);
    }

    return grouped;
}

function focusBlockAtReplacementEnd(block: HTMLElement, offset: number): void {
    focusBlockAtOffset(block, Math.min(offset, getBlockText(block).length), { scroll: "none" });
}

function matchStartPoint(match: FindMatch): SearchPoint {
    return {
        blockIndex: match.blockIndex,
        offset: match.startOffset,
    };
}

function createHighlightRect(rect: DOMRect, active: boolean): HTMLElement {
    const highlight = document.createElement("div");
    highlight.className = "find-highlight-rect";
    highlight.style.left = `${rect.left}px`;
    highlight.style.top = `${rect.top}px`;
    highlight.style.width = `${Math.max(1, rect.width)}px`;
    highlight.style.height = `${Math.max(1, rect.height)}px`;
    if (active) {
        highlight.dataset.active = "true";
    }

    return highlight;
}

function isRectOutsideViewport(rect: DOMRect): boolean {
    return rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth;
}

function isWholeWordMatch(text: string, startOffset: number, endOffset: number): boolean {
    return !isWordCharacter(readPreviousCharacter(text, startOffset)) &&
        !isWordCharacter(readNextCharacter(text, endOffset));
}

function isWordCharacter(character: string): boolean {
    return character !== "" && wholeWordCharacterPattern.test(character);
}

function readPreviousCharacter(text: string, offset: number): string {
    if (offset <= 0) {
        return "";
    }

    const characters = Array.from(text.slice(0, offset));
    return characters[characters.length - 1] ?? "";
}

function readNextCharacter(text: string, offset: number): string {
    return Array.from(text.slice(offset))[0] ?? "";
}
