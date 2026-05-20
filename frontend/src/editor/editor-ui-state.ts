import type { BlockType } from "./block-model";
import { readBlockType } from "./block-model";

type EditorUiStateOptions = {
    hasBlockSource: (type: BlockType) => boolean;
};

let options: EditorUiStateOptions = {
    hasBlockSource: () => false,
};
let indicatedActiveBlock: HTMLElement | null = null;
let blockSourceRevealBlocks: HTMLElement[] = [];

export function configureEditorUiState(nextOptions: Partial<EditorUiStateOptions>): void {
    options = { ...options, ...nextOptions };
}

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

export function syncBlockSourceReveal(block: HTMLElement | null): void {
    const nextBlocks = new Set<HTMLElement>();
    const activeBlock = block?.isConnected ? block : null;

    if (activeBlock) {
        addBlockSourceRevealTarget(nextBlocks, activeBlock);
    }

    for (const revealedBlock of blockSourceRevealBlocks) {
        if (!nextBlocks.has(revealedBlock)) {
            delete revealedBlock.dataset.blockSourceActive;
        }
    }

    for (const revealedBlock of Array.from(nextBlocks)) {
        revealedBlock.dataset.blockSourceActive = "true";
    }

    blockSourceRevealBlocks = Array.from(nextBlocks);
}

function addBlockSourceRevealTarget(targets: Set<HTMLElement>, block: HTMLElement | null): void {
    if (!block?.isConnected) {
        return;
    }

    const type = readBlockType(block.dataset.type);
    if (options.hasBlockSource(type)) {
        targets.add(block);
    }
}
