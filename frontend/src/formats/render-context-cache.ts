import type { ParsedBlock } from "../editor/blocks/model";
import type { DocumentRenderContext, RenderCapability } from "./types";

/** A format opts into caching; arbitrary context data need not be JSON. */
export function createRenderContextCache() {
    let owner: RenderCapability | null = null;
    let key: string | undefined;
    let current: DocumentRenderContext = { references: {} };
    return {
        get current(): DocumentRenderContext { return current; },
        update(render: RenderCapability, blocks: ParsedBlock[]): boolean {
            const next = render.readRenderContext?.(blocks) ?? { references: {} };
            // Compute before rendering, which may mutate render cursors.
            const nextKey = render.readRenderContextKey?.(next);
            if (owner === render && nextKey !== undefined && key === nextKey) return false;
            owner = render;
            key = nextKey;
            current = next;
            return true;
        },
    };
}
