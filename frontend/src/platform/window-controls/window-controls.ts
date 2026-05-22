import "./window-controls.css";
import windowControlsHtml from "./window-controls.html?raw";
import { System, Window } from "@wailsio/runtime";
import { getElement } from "../../utils/dom";

let maximiseButton: HTMLButtonElement | null = null;
let snapAssistTimer = 0;

export function installWindowControls(): void {
    if (!isWindowsHost()) {
        return;
    }

    document.body.insertAdjacentHTML("afterbegin", windowControlsHtml);
    document.body.classList.add("windows-host");

    const titlebar = getElement<HTMLElement>("windows-titlebar");
    titlebar.hidden = false;
    titlebar.addEventListener("click", handleWindowControlClick);

    maximiseButton = getElement<HTMLButtonElement>("windows-maximise-button");
    maximiseButton.addEventListener("pointerenter", scheduleSnapAssist);
    maximiseButton.addEventListener("pointerleave", cancelSnapAssist);
    maximiseButton.addEventListener("pointerdown", cancelSnapAssist);

    document.body.classList.add("window-focused");
    window.addEventListener("focus", () => document.body.classList.add("window-focused"));
    window.addEventListener("blur", () => document.body.classList.remove("window-focused"));
    window.addEventListener("resize", () => void syncMaximiseButton());

    void syncMaximiseButton();
}

function isWindowsHost(): boolean {
    return System.IsWindows() || isWindowsWebViewHost();
}

function isWindowsWebViewHost(): boolean {
    const chromeHost = (window as Window & { chrome?: { webview?: { postMessage?: unknown } } }).chrome;

    return Boolean(
        chromeHost?.webview?.postMessage &&
            (navigator.userAgent.includes("Windows") || navigator.platform.startsWith("Win")),
    );
}

function handleWindowControlClick(event: MouseEvent): void {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>("[data-window-action]");
    const action = button?.dataset.windowAction;

    if (!action) {
        return;
    }

    if (action === "minimise") {
        void Window.Minimise();
        return;
    }

    if (action === "maximise") {
        cancelSnapAssist();
        void Window.ToggleMaximise().then(syncMaximiseButton);
        return;
    }

    if (action === "close") {
        void Window.Close();
    }
}

function scheduleSnapAssist(): void {
    if (!isWindowsHost() || snapAssistTimer) {
        return;
    }

    snapAssistTimer = window.setTimeout(() => {
        snapAssistTimer = 0;
        void Window.SnapAssist();
    }, 500);
}

function cancelSnapAssist(): void {
    if (!snapAssistTimer) {
        return;
    }

    window.clearTimeout(snapAssistTimer);
    snapAssistTimer = 0;
}

async function syncMaximiseButton(): Promise<void> {
    if (!maximiseButton || !isWindowsHost()) {
        return;
    }

    const isMaximised = await Window.IsMaximised();
    const icon = maximiseButton.querySelector<HTMLElement>(".window-control-icon");

    maximiseButton.setAttribute("aria-label", isMaximised ? "Restore" : "Maximize");
    if (icon) {
        icon.innerHTML = isMaximised ? "&#xE923;" : "&#xE922;";
    }
}
