export function createCodeFence(text: string, preferredFence?: string): string {
    if (preferredFence && /^(`{3,}|~{3,})$/.test(preferredFence) && isCodeFenceSafe(text, preferredFence)) {
        return preferredFence;
    }

    const longestRun = text.match(/`+/g)?.reduce((longest, run) => Math.max(longest, run.length), 0) ?? 0;
    return "`".repeat(Math.max(3, longestRun + 1));
}

function isCodeFenceSafe(text: string, fence: string): boolean {
    const fenceCharacter = fence[0];
    const closingFence = fenceCharacter.repeat(fence.length);

    return !text.split("\n").some((line) => {
        const trimmed = line.trim();
        return trimmed.startsWith(closingFence) && trimmed.split("").every((character) => character === fenceCharacter);
    });
}
