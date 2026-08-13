export type CenteredFrame = {
    element: HTMLElement;
    content: HTMLElement;
    isOpen: () => boolean;
    show: () => void;
    hide: (onHidden?: () => void) => void;
    toggle: () => void;
};

type CenteredFrameOptions = {
    className?: string;
    label: string;
};

const visibleFrames = new Set<HTMLElement>();

function syncCenteredFramePageState(): void {
    document.body.classList.toggle("centered-frame-active", visibleFrames.size > 0);
}

export function createCenteredFrame(options: CenteredFrameOptions): CenteredFrame {
    const element = document.createElement("aside");
    element.className = ["centered-frame", options.className].filter(Boolean).join(" ");
    element.setAttribute("aria-label", options.label);
    element.hidden = true;

    const content = document.createElement("div");
    content.className = "centered-frame-content";
    element.append(content);

    let focusBeforeOpen: HTMLElement | null = null;
    let cancelPendingHide: (() => void) | null = null;
    let activeGlassSurface: HTMLElement | null = null;
    let pendingGlassPointer: { surface: HTMLElement; clientX: number; clientY: number } | null = null;
    let glassPointerFrame = 0;

    const clearGlassPointer = (): void => {
        pendingGlassPointer = null;
        if (glassPointerFrame) {
            window.cancelAnimationFrame(glassPointerFrame);
            glassPointerFrame = 0;
        }
        if (activeGlassSurface) {
            delete activeGlassSurface.dataset.glassPointer;
            activeGlassSurface = null;
        }
    };

    content.addEventListener("pointermove", (event) => {
        const target = event.target instanceof Element
            ? event.target.closest<HTMLElement>(".centered-frame-content > *")
            : null;
        if (!target || target.parentElement !== content) {
            clearGlassPointer();
            return;
        }

        pendingGlassPointer = { surface: target, clientX: event.clientX, clientY: event.clientY };
        if (glassPointerFrame) {
            return;
        }
        glassPointerFrame = window.requestAnimationFrame(() => {
            glassPointerFrame = 0;
            const pending = pendingGlassPointer;
            pendingGlassPointer = null;
            if (!pending) {
                return;
            }

            if (activeGlassSurface !== pending.surface) {
                if (activeGlassSurface) {
                    delete activeGlassSurface.dataset.glassPointer;
                }
                activeGlassSurface = pending.surface;
                activeGlassSurface.dataset.glassPointer = "true";
            }

            const rect = pending.surface.getBoundingClientRect();
            pending.surface.style.setProperty("--glass-pointer-x", `${pending.clientX - rect.left}px`);
            pending.surface.style.setProperty("--glass-pointer-y", `${pending.clientY - rect.top}px`);
        });
    });
    content.addEventListener("pointerleave", clearGlassPointer);

    const isOpen = (): boolean => !element.hidden && element.dataset.frameState !== "closing";

    const show = (): void => {
        cancelPendingHide?.();
        cancelPendingHide = null;
        if (isOpen()) {
            return;
        }

        const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        if (!activeElement || !element.contains(activeElement)) {
            focusBeforeOpen = activeElement;
        }
        visibleFrames.add(element);
        syncCenteredFramePageState();
        element.hidden = false;
        element.dataset.frameState = "opening";
        void element.offsetWidth;
        element.dataset.frameState = "open";
    };

    const hide = (onHidden?: () => void): void => {
        if (element.hidden || element.dataset.frameState === "closing") {
            return;
        }

        element.dataset.frameState = "closing";
        let hideTimer = 0;

        const cleanup = (): void => {
            element.removeEventListener("transitionend", handleTransitionEnd);
            if (hideTimer) {
                window.clearTimeout(hideTimer);
                hideTimer = 0;
            }
            cancelPendingHide = null;
        };

        const finish = (): void => {
            cleanup();
            if (element.dataset.frameState !== "closing") {
                return;
            }
            element.hidden = true;
            clearGlassPointer();
            delete element.dataset.frameState;
            visibleFrames.delete(element);
            syncCenteredFramePageState();
            onHidden?.();
            if (document.activeElement instanceof HTMLElement && element.contains(document.activeElement)) {
                document.activeElement.blur();
            }
            if (focusBeforeOpen?.isConnected) {
                focusBeforeOpen.focus({ preventScroll: true });
            }
            focusBeforeOpen = null;
        };

        const handleTransitionEnd = (event: TransitionEvent): void => {
            if (event.target === element && event.propertyName === "transform") {
                finish();
            }
        };

        element.addEventListener("transitionend", handleTransitionEnd);
        hideTimer = window.setTimeout(finish, 180);
        cancelPendingHide = cleanup;
    };

    return {
        element,
        content,
        isOpen,
        show,
        hide,
        toggle: () => {
            if (isOpen()) {
                hide();
            } else {
                show();
            }
        },
    };
}
