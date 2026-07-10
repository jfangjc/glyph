let clearStatusTimer: number | null = null;

export function reportEditorError(message: string): void {
    const status = document.getElementById("editor-status");
    if (!status) {
        return;
    }

    status.textContent = message;
    status.dataset.state = "error";
    if (clearStatusTimer !== null) {
        window.clearTimeout(clearStatusTimer);
    }
    clearStatusTimer = window.setTimeout(() => {
        status.textContent = "";
        delete status.dataset.state;
        clearStatusTimer = null;
    }, 6000);
}
