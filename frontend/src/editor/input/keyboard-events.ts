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
