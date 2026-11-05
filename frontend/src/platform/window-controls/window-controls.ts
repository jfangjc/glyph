import "./window-controls.css";
import windowControlsHtml from "./window-controls.html?raw";
import { Window } from "@wailsio/runtime";
import { readHostPlatform } from "../host-platform";
import type { ShortcutLabelPlatform } from "../../app/keymap";
import { getElement } from "../../utils/dom";
import { canUseNativeRuntime } from "../runtime";

type AppPlatform = ShortcutLabelPlatform;

let maximiseButton: HTMLButtonElement | null = null;
let snapAssistTimer = 0;
let hostPlatform: AppPlatform | null = null;

export function installWindowControls(): void {
    // Keep navigation available even in previews with an unrecognised UA.
    const platform = readHostPlatform();

    hostPlatform = platform;
    document.body.insertAdjacentHTML("afterbegin", windowControlsHtml);
    document.body.classList.add("app-titlebar-host");
    if (platform) document.body.classList.add(`${platform}-host`);

    const titlebar = getElement<HTMLElement>("app-titlebar");
    titlebar.hidden = false;
    titlebar.dataset.platform = platform ?? "browser";

    titlebar.addEventListener("click", handleWindowControlClick);

    const controls = getElement<HTMLElement>("app-window-controls");
    if (platform === "windows" || platform === "linux") {
        controls.hidden = false;
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
    const icon = maximiseButton.querySelector(".window-control-icon path");

    maximiseButton.setAttribute("aria-label", isMaximised ? "Restore" : "Maximize");
    if (icon) {
        icon.setAttribute("d", isMaximised
            ? "M3.5 3.5h7v7h-7zM1.5 8.5v-7h7"
            : "M1.5 1.5h9v9h-9z");
    }
}
