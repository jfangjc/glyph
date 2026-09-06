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
        if (element.hidden) return;
        const restore = element.contains(document.activeElement);
        element.hidden = true;
        delete element.dataset.frameState;
        visibleFrames.delete(element);
        syncCenteredFramePageState();
        onHidden?.();
        if (restore && focusBeforeOpen?.isConnected) focusBeforeOpen.focus({ preventScroll: true });
        focusBeforeOpen = null;
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
