export type CenteredFrame = {
    element: HTMLElement;
    content: HTMLElement;
    isOpen: () => boolean;
    show: () => void;
    hide: () => void;
    toggle: () => void;
};

type CenteredFrameOptions = {
    className?: string;
    label: string;
};

export function createCenteredFrame(options: CenteredFrameOptions): CenteredFrame {
    const element = document.createElement("aside");
    element.className = ["centered-frame", options.className].filter(Boolean).join(" ");
    element.setAttribute("aria-label", options.label);
    element.hidden = true;

    const content = document.createElement("div");
    content.className = "centered-frame-content";
    element.append(content);

    return {
        element,
        content,
        isOpen: () => !element.hidden,
        show: () => {
            element.hidden = false;
        },
        hide: () => {
            element.hidden = true;
        },
        toggle: () => {
            element.hidden = !element.hidden;
        },
    };
}
