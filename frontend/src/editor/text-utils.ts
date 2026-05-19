const htmlEscapes: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};

export function clamp(value: number, min: number, max: number): number {
    if (max < min) {
        return min;
    }

    return Math.min(Math.max(value, min), max);
}

export function fileNameFromPath(path: string): string {
    const normalized = path.replace(/\\/g, "/");
    return normalized.slice(normalized.lastIndexOf("/") + 1) || path || "Untitled";
}

export function createCodeFence(text: string, preferredFence?: string): string {
    if (preferredFence && /^(`{3,}|~{3,})$/.test(preferredFence) && isCodeFenceSafe(text, preferredFence)) {
        return preferredFence;
    }

    const longestRun = text.match(/`+/g)?.reduce((longest, run) => Math.max(longest, run.length), 0) ?? 0;
    return "`".repeat(Math.max(3, longestRun + 1));
}

export function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (character) => htmlEscapes[character]);
}

function isCodeFenceSafe(text: string, fence: string): boolean {
    const fenceCharacter = fence[0];
    const closingFence = fenceCharacter.repeat(fence.length);

    return !text.split("\n").some((line) => {
        const trimmed = line.trim();
        return trimmed.startsWith(closingFence) && trimmed.split("").every((character) => character === fenceCharacter);
    });
}
