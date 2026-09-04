let indicatedActiveBlock: HTMLElement | null = null;

export function syncActiveBlockIndicator(block: HTMLElement | null): void {
    const nextBlock = block?.isConnected ? block : null;

    if (indicatedActiveBlock === nextBlock) {
        return;
    }

    if (indicatedActiveBlock) {
        delete indicatedActiveBlock.dataset.activeBlock;
    }

    indicatedActiveBlock = nextBlock;

    if (indicatedActiveBlock) {
        indicatedActiveBlock.dataset.activeBlock = "true";
    }
}
