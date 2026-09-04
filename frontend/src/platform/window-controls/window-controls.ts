import "./window-controls.css";
import windowControlsHtml from "./window-controls.html?raw";
import { System, Window } from "@wailsio/runtime";
import {
    readShortcutLabel,
    type AppMenuCommand,
    type ShortcutLabelPlatform,
} from "../../app/keymap";
import { getElement } from "../../utils/dom";

export const appMenuCommandEvent = "glyph:app-menu-command";
export type { AppMenuCommand } from "../../app/keymap";

export type AppMenuCommandDetail = {
    command: AppMenuCommand;
    focusOwner: HTMLElement | null;
};

type AppPlatform = ShortcutLabelPlatform;

let maximiseButton: HTMLButtonElement | null = null;
let snapAssistTimer = 0;
let menuCloseTimer = 0;
const menuPanelHideCleanups = new WeakMap<HTMLElement, () => void>();
let activeMenuId: string | null = null;
let hostPlatform: AppPlatform | null = null;
let lastNonTitlebarFocus: HTMLElement | null = null;

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
    syncAppMenuShortcutLabels(titlebar, platform);
    titlebar.addEventListener("click", handleTitlebarClick);
    titlebar.addEventListener("keydown", handleTitlebarKeydown);
    titlebar.addEventListener("pointerover", handleTitlebarPointerOver);
    titlebar.addEventListener("pointerleave", handleTitlebarPointerLeave);

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
    document.addEventListener("mousedown", handleDocumentMouseDown, true);
    document.addEventListener("keydown", handleDocumentKeydown, true);
    document.addEventListener("focusin", (event) => {
        const target = event.target;
        if (target instanceof HTMLElement && !target.closest("#app-titlebar")) {
            lastNonTitlebarFocus = target;
        }
    });
    window.addEventListener("focus", () => document.body.classList.add("window-focused"));
    window.addEventListener("blur", () => {
        document.body.classList.remove("window-focused");
        closeMenus();
    });
    window.addEventListener("resize", () => {
        void syncMaximiseButton();
        syncOpenMenuPanelPosition();
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

function syncAppMenuShortcutLabels(titlebar: HTMLElement, platform: AppPlatform): void {
    for (const item of Array.from(titlebar.querySelectorAll<HTMLButtonElement>("[data-app-command]"))) {
        const command = item.dataset.appCommand;
        if (!command) {
            continue;
        }

        const label = readShortcutLabel(command as AppMenuCommand, platform);
        let shortcut = item.querySelector<HTMLElement>(".app-menu-shortcut");
        if (!label) {
            shortcut?.remove();
            continue;
        }

        if (!shortcut) {
            shortcut = document.createElement("span");
            shortcut.className = "app-menu-shortcut";
            item.append(shortcut);
        }

        shortcut.textContent = label;
    }
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

function handleTitlebarClick(event: MouseEvent): void {
    const target = event.target as Element | null;
    const commandButton = target?.closest<HTMLButtonElement>("[data-app-command]");
    if (commandButton) {
        if (!commandButton.disabled) {
            dispatchAppMenuCommand(commandButton.dataset.appCommand as AppMenuCommand);
            closeMenus();
        }
        return;
    }

    const menuButton = target?.closest<HTMLButtonElement>("[data-menu-button]");
    if (menuButton) {
        event.preventDefault();
        const menuId = menuButton.dataset.menuButton;
        if (!menuId) {
            return;
        }

        if (activeMenuId === menuId) {
            closeMenus();
        } else {
            openMenu(menuId);
        }
        return;
    }

    handleWindowControlClick(event);
}

function handleWindowControlClick(event: MouseEvent): void {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>("[data-window-action]");
    const action = button?.dataset.windowAction;

    if (!action) {
        return;
    }

    if (!canUseWindowRuntime()) {
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

function handleTitlebarKeydown(event: KeyboardEvent): void {
    const target = event.target as Element | null;
    const menuButton = target?.closest<HTMLButtonElement>("[data-menu-button]");
    const menuItem = target?.closest<HTMLButtonElement>("[data-app-command]");

    if (event.key === "Escape") {
        closeMenus({ restoreFocus: true });
        return;
    }

    if (menuButton) {
        handleMenuButtonKeydown(event, menuButton);
        return;
    }

    if (menuItem) {
        handleMenuItemKeydown(event, menuItem);
    }
}

function handleMenuButtonKeydown(event: KeyboardEvent, button: HTMLButtonElement): void {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const menuId = button.dataset.menuButton;
        if (menuId) {
            openMenu(menuId, { focusFirstItem: true });
        }
        return;
    }

    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const nextButton = focusAdjacentMenuButton(button, event.key === "ArrowRight" ? 1 : -1);
        const menuId = nextButton?.dataset.menuButton;
        if (activeMenuId && menuId) {
            openMenu(menuId);
        }
    }
}

function handleMenuItemKeydown(event: KeyboardEvent, item: HTMLButtonElement): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        focusAdjacentMenuItem(item, event.key === "ArrowDown" ? 1 : -1);
        return;
    }

    if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        focusEdgeMenuItem(item, event.key === "Home" ? "first" : "last");
        return;
    }

    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const nextButton = focusAdjacentMenuButton(getActiveMenuButton() ?? item, event.key === "ArrowRight" ? 1 : -1);
        const menuId = nextButton?.dataset.menuButton;
        if (menuId) {
            openMenu(menuId, { focusFirstItem: true });
        }
    }
}

function handleTitlebarPointerOver(event: PointerEvent): void {
    if (!activeMenuId) {
        return;
    }

    cancelMenuClose();
    const menuButton = (event.target as Element | null)?.closest<HTMLButtonElement>("[data-menu-button]");
    const menuId = menuButton?.dataset.menuButton;
    if (menuId && menuId !== activeMenuId) {
        openMenu(menuId);
    }
}

function handleTitlebarPointerLeave(): void {
    scheduleMenuClose();
}

function handleDocumentMouseDown(event: MouseEvent): void {
    const titlebar = document.getElementById("app-titlebar");
    if (activeMenuId && titlebar && !titlebar.contains(event.target as Node | null)) {
        closeMenus();
    }
}

function openMenu(menuId: string, options: { focusFirstItem?: boolean } = {}): void {
    cancelMenuClose();
    const titlebar = getElement<HTMLElement>("app-titlebar");
    const menuButtons = Array.from(titlebar.querySelectorAll<HTMLButtonElement>("[data-menu-button]"));
    const panels = Array.from(titlebar.querySelectorAll<HTMLElement>("[data-menu-panel]"));

    activeMenuId = menuId;
    titlebar.dataset.menuOpen = "true";

    for (const button of menuButtons) {
        button.setAttribute("aria-expanded", button.dataset.menuButton === menuId ? "true" : "false");
    }

    for (const panel of panels) {
        const isActive = panel.dataset.menuPanel === menuId;
        if (isActive) {
            cancelPanelHide(panel);
            panel.hidden = false;
            panel.dataset.menuPanelState = "opening";
            panel.style.left = "";
            void panel.offsetWidth;
            panel.dataset.menuPanelState = "open";
        } else if (!panel.hidden) {
            closeMenuPanel(panel);
        }
    }

    syncOpenMenuPanelPosition();

    if (options.focusFirstItem) {
        getOpenMenuItems()[0]?.focus();
    }
}

function closeMenus(options: {
    blurFocus?: boolean;
    restoreFocus?: boolean;
    delayMenuBar?: boolean;
} = {}): void {
    cancelMenuClose();
    if (!activeMenuId) {
        return;
    }

    const titlebar = document.getElementById("app-titlebar");
    const activeButton = getActiveMenuButton();

    activeMenuId = null;
    if (!options.delayMenuBar) {
        titlebar?.removeAttribute("data-menu-open");
    }

    for (const button of Array.from(titlebar?.querySelectorAll<HTMLButtonElement>("[data-menu-button]") ?? [])) {
        button.setAttribute("aria-expanded", "false");
    }

    for (const panel of Array.from(titlebar?.querySelectorAll<HTMLElement>("[data-menu-panel]") ?? [])) {
        if (!panel.hidden) {
            closeMenuPanel(panel, () => {
                if (options.delayMenuBar && !activeMenuId) {
                    titlebar?.removeAttribute("data-menu-open");
                }
            });
        }
    }

    if (options.restoreFocus) {
        activeButton?.focus();
    } else if (options.blurFocus) {
        blurTitlebarFocus(titlebar);
    }
}

function handleDocumentKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented) {
        return;
    }

    if (event.key === "F10" || (event.key === "Alt" && hostPlatform !== "mac")) {
        event.preventDefault();
        document.querySelector<HTMLButtonElement>("#app-titlebar [data-menu-button]")?.focus();
        return;
    }

    if (!activeMenuId) return;

    const titlebar = document.getElementById("app-titlebar");
    if (event.key === "Escape") {
        if (!titlebar?.contains(event.target as Node | null)) {
            closeMenus({ blurFocus: true });
        }
        return;
    }

    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        closeMenus({ blurFocus: true });
    }
}

function scheduleMenuClose(): void {
    if (!activeMenuId || menuCloseTimer) {
        return;
    }

    menuCloseTimer = window.setTimeout(() => {
        menuCloseTimer = 0;
        closeMenus({ blurFocus: true, delayMenuBar: true });
    }, 350);
}

function cancelMenuClose(): void {
    if (!menuCloseTimer) {
        return;
    }

    window.clearTimeout(menuCloseTimer);
    menuCloseTimer = 0;
}

function closeMenuPanel(panel: HTMLElement, onHidden?: () => void): void {
    cancelPanelHide(panel);
    panel.dataset.menuPanelState = "closing";

    let hideTimer = 0;
    let handleTransitionEnd: (event: TransitionEvent) => void;

    const cleanup = (): void => {
        panel.removeEventListener("transitionend", handleTransitionEnd);
        if (hideTimer) {
            window.clearTimeout(hideTimer);
            hideTimer = 0;
        }
        menuPanelHideCleanups.delete(panel);
    };

    const hide = (): void => {
        cleanup();
        if (panel.dataset.menuPanelState !== "closing") {
            return;
        }
        panel.hidden = true;
        delete panel.dataset.menuPanelState;
        panel.style.left = "";
        onHidden?.();
    };

    handleTransitionEnd = (event: TransitionEvent): void => {
        if (event.target !== panel || event.propertyName !== "transform") {
            return;
        }
        hide();
    };

    panel.addEventListener("transitionend", handleTransitionEnd);
    hideTimer = window.setTimeout(hide, 220);
    menuPanelHideCleanups.set(panel, cleanup);
}

function cancelPanelHide(panel: HTMLElement): void {
    menuPanelHideCleanups.get(panel)?.();
}

function blurTitlebarFocus(titlebar: HTMLElement | null): void {
    const activeElement = document.activeElement;
    if (titlebar && activeElement instanceof HTMLElement && titlebar.contains(activeElement)) {
        activeElement.blur();
    }
}

function syncOpenMenuPanelPosition(): void {
    if (!activeMenuId) {
        return;
    }

    const panel = document.querySelector<HTMLElement>(
        `#app-titlebar [data-menu-panel="${cssEscape(activeMenuId)}"]`,
    );
    if (!panel || panel.hidden) {
        return;
    }

    panel.style.left = "";

    const margin = 8;
    const rect = panel.getBoundingClientRect();
    let offset = 0;

    if (rect.right > window.innerWidth - margin) {
        offset = window.innerWidth - margin - rect.right;
    }

    if (rect.left + offset < margin) {
        offset += margin - (rect.left + offset);
    }

    if (offset !== 0) {
        panel.style.left = `${Math.round(offset)}px`;
    }
}

function focusAdjacentMenuButton(current: Element, direction: 1 | -1): HTMLButtonElement | null {
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("#app-titlebar [data-menu-button]"));
    if (!buttons.length) {
        return null;
    }

    const currentButton = current.closest<HTMLButtonElement>("[data-menu-button]");
    const currentIndex = currentButton ? buttons.indexOf(currentButton) : -1;
    const nextIndex = currentIndex >= 0 ? (currentIndex + direction + buttons.length) % buttons.length : 0;
    const nextButton = buttons[nextIndex];
    nextButton.focus();
    return nextButton;
}

function focusAdjacentMenuItem(current: HTMLButtonElement, direction: 1 | -1): void {
    const items = getOpenMenuItems();
    if (!items.length) {
        return;
    }

    const currentIndex = items.indexOf(current);
    const nextIndex = currentIndex >= 0 ? (currentIndex + direction + items.length) % items.length : 0;
    items[nextIndex].focus();
}

function focusEdgeMenuItem(current: HTMLButtonElement, edge: "first" | "last"): void {
    const items = getOpenMenuItems();
    const item = edge === "first" ? items[0] : items[items.length - 1];

    if (item && item !== current) {
        item.focus();
    }
}

function getOpenMenuItems(): HTMLButtonElement[] {
    if (!activeMenuId) {
        return [];
    }

    return Array.from(
        document.querySelectorAll<HTMLButtonElement>(
            `#app-titlebar [data-menu-panel="${cssEscape(activeMenuId)}"] [data-app-command]:not(:disabled)`,
        ),
    );
}

function getActiveMenuButton(): HTMLButtonElement | null {
    if (!activeMenuId) {
        return null;
    }

    return document.querySelector<HTMLButtonElement>(`#app-titlebar [data-menu-button="${cssEscape(activeMenuId)}"]`);
}

function dispatchAppMenuCommand(command: AppMenuCommand): void {
    window.dispatchEvent(
        new CustomEvent<AppMenuCommandDetail>(appMenuCommandEvent, {
            detail: { command, focusOwner: lastNonTitlebarFocus },
        }),
    );
}

function scheduleSnapAssist(): void {
    if (hostPlatform !== "windows" || snapAssistTimer || !canUseWindowRuntime()) {
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
    if (!maximiseButton || !canUseWindowRuntime()) {
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

function canUseWindowRuntime(): boolean {
    return Boolean(
        (window as Window & { _wails?: { environment?: unknown } })._wails?.environment ||
            (window as Window & { chrome?: { webview?: { postMessage?: unknown } } }).chrome?.webview?.postMessage ||
            (window as Window & { webkit?: { messageHandlers?: { external?: { postMessage?: unknown } } } }).webkit
                ?.messageHandlers?.external?.postMessage ||
            (window as Window & { wails?: { invoke?: unknown } }).wails?.invoke,
    );
}

function cssEscape(value: string): string {
    return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}
