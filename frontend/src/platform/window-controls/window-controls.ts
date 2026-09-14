import "./window-controls.css";
import windowControlsHtml from "./window-controls.html?raw";
import { System, Window } from "@wailsio/runtime";
import type { ShortcutLabelPlatform } from "../../app/keymap";
import { getElement } from "../../utils/dom";
import { canUseNativeRuntime } from "../runtime";

type AppPlatform = ShortcutLabelPlatform;

let maximiseButton: HTMLButtonElement | null = null;
let snapAssistTimer = 0;
let hostPlatform: AppPlatform | null = null;

export function installWindowControls(): void {
    const platform = readHostPlatform();
    if (!platform) {
        return;
    }

    hostPlatform = platform;
    document.body.insertAdjacentHTML("afterbegin", windowControlsHtml);
    document.body.classList.add("app-titlebar-host", `${platform}-host`);

    const titlebar = getElement<HTMLElement>("app-titlebar");
    titlebar.hidden = false;
    titlebar.dataset.platform = platform;

    titlebar.addEventListener("click", handleWindowControlClick);

    const controls = getElement<HTMLElement>("app-window-controls");
    if (platform === "windows" || platform === "linux") {
        controls.hidden = false;
        if (platform === "linux") {
            syncLinuxWindowControlIcons(controls);
        }

        maximiseButton = getElement<HTMLButtonElement>("app-maximise-button");
        maximiseButton.addEventListener("pointerenter", scheduleSnapAssist);
        maximiseButton.addEventListener("pointerleave", cancelSnapAssist);
        maximiseButton.addEventListener("pointerdown", cancelSnapAssist);
    }

    document.body.classList.add("window-focused");
    document.addEventListener("keydown", handleWindowKeydown, true);
    window.addEventListener("focus", () => document.body.classList.add("window-focused"));
    window.addEventListener("blur", () => {
        document.body.classList.remove("window-focused");
    });
    window.addEventListener("resize", () => {
        void syncMaximiseButton();
    });

    void syncMaximiseButton();
}

function readHostPlatform(): AppPlatform | null {
    if (System.IsWindows() || isWindowsWebViewHost() || isWindowsBrowserPreview()) {
        return "windows";
    }

    if (System.IsMac() || isMacBrowserPreview()) {
        return "mac";
    }

    if (System.IsLinux() || isLinuxBrowserPreview()) {
        return "linux";
    }

    return null;
}

function isWindowsWebViewHost(): boolean {
    const chromeHost = (window as Window & { chrome?: { webview?: { postMessage?: unknown } } }).chrome;

    return Boolean(
        chromeHost?.webview?.postMessage &&
            (navigator.userAgent.includes("Windows") || navigator.platform.startsWith("Win")),
    );
}

function isWindowsBrowserPreview(): boolean {
    return navigator.platform.toLowerCase().startsWith("win") || navigator.userAgent.includes("Windows");
}

function isMacBrowserPreview(): boolean {
    return navigator.platform.toLowerCase().includes("mac") || navigator.userAgent.includes("Mac OS");
}

function isLinuxBrowserPreview(): boolean {
    return navigator.platform.toLowerCase().includes("linux") || navigator.userAgent.includes("Linux");
}

function handleWindowControlClick(event: MouseEvent): void {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>("[data-window-action]");
    const action = button?.dataset.windowAction;

    if (!action) {
        return;
    }

    if (!canUseNativeRuntime()) {
        return;
    }

    if (action === "minimise") {
        void Window.Minimise().catch((error) => console.error("Failed to minimise window:", error));
        return;
    }

    if (action === "maximise") {
        cancelSnapAssist();
        void Window.ToggleMaximise()
            .then(syncMaximiseButton)
            .catch((error) => console.error("Failed to toggle maximise window:", error));
        return;
    }

    if (action === "close") {
        void Window.Close().catch((error) => console.error("Failed to close window:", error));
    }
}

// Preserve the existing titlebar key suppression until native keyboard behavior
// can be compared. The retired menu had no button to focus for these keys.
function handleWindowKeydown(event: KeyboardEvent): void {
    if (!event.defaultPrevented && (event.key === "F10" || (event.key === "Alt" && hostPlatform !== "mac"))) {
        event.preventDefault();
    }
}

function scheduleSnapAssist(): void {
    if (hostPlatform !== "windows" || snapAssistTimer || !canUseNativeRuntime()) {
        return;
    }

    snapAssistTimer = window.setTimeout(() => {
        snapAssistTimer = 0;
        void Window.SnapAssist().catch((error) => console.error("Failed to open snap assist:", error));
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
    if (!maximiseButton || !canUseNativeRuntime()) {
        return;
    }

    const isMaximised = await Window.IsMaximised().catch(() => false);
    const icon = maximiseButton.querySelector<HTMLElement>(".window-control-icon");

    maximiseButton.setAttribute("aria-label", isMaximised ? "Restore" : "Maximize");
    if (icon) {
        if (hostPlatform === "linux") {
            icon.innerHTML = isMaximised ? "&#x2750;" : "&#x25A1;";
        } else {
            icon.innerHTML = isMaximised ? "&#xE923;" : "&#xE922;";
        }
    }
}

function syncLinuxWindowControlIcons(controls: HTMLElement): void {
    const icons: Record<string, string> = {
        minimise: "-",
        maximise: "&#x25A1;",
        close: "&times;",
    };

    for (const button of Array.from(controls.querySelectorAll<HTMLButtonElement>("[data-window-action]"))) {
        const icon = button.querySelector<HTMLElement>(".window-control-icon");
        const action = button.dataset.windowAction ?? "";
        if (icon) {
            icon.innerHTML = icons[action] ?? "";
        }
    }
}
