export function reportEditorError(message: string): void {
    const status = document.getElementById("editor-status");
    if (!status) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const text = document.createElement("span");
    text.className = "editor-error-message";
    text.textContent = message;
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "editor-error-close";
    dismiss.textContent = "\u00d7";
    dismiss.setAttribute("aria-label", "Close error");
    dismiss.title = "Close error";
    dismiss.addEventListener("click", () => {
        const restoreFocus = document.activeElement === dismiss;
        status.replaceChildren();
        delete status.dataset.state;
        if (restoreFocus && previousFocus?.isConnected && !status.contains(previousFocus)) {
            previousFocus.focus({ preventScroll: true });
        }
    });
    status.replaceChildren(text, dismiss);
    status.dataset.state = "error";
}
