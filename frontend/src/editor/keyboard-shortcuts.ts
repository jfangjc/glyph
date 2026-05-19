export type InlineFormat = "bold" | "italic";
export type ZoomShortcut = "in" | "out" | "reset";

export function readZoomShortcut(event: KeyboardEvent): ZoomShortcut | null {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) {
        return null;
    }

    if (event.key === "+" || event.key === "=" || event.code === "NumpadAdd") {
        return "in";
    }

    if (event.key === "-" || event.key === "_" || event.code === "NumpadSubtract") {
        return "out";
    }

    if (event.key === "0" || event.code === "Numpad0") {
        return "reset";
    }

    return null;
}

export function isOpenFileShortcut(event: KeyboardEvent): boolean {
    return event.key.toLowerCase() === "o" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
}

export function isSaveFileShortcut(event: KeyboardEvent): boolean {
    return event.key.toLowerCase() === "s" && (event.ctrlKey || event.metaKey) && !event.altKey;
}

export function isSelectAllShortcut(event: KeyboardEvent): boolean {
    return event.key.toLowerCase() === "a" && (event.ctrlKey || event.metaKey);
}

export function readInlineFormatShortcut(event: KeyboardEvent): InlineFormat | null {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) {
        return null;
    }

    const key = event.key.toLowerCase();
    if (key === "b") {
        return "bold";
    }

    if (key === "i") {
        return "italic";
    }

    return null;
}

export function isPlainTextKey(event: KeyboardEvent): boolean {
    return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
}

export function isCompositionEvent(event: Event, isComposingText: boolean): boolean {
    return (
        isComposingText ||
        (typeof InputEvent !== "undefined" && event instanceof InputEvent && event.isComposing) ||
        (typeof KeyboardEvent !== "undefined" &&
            event instanceof KeyboardEvent &&
            (event.isComposing || event.key === "Process"))
    );
}
