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

export function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (character) => htmlEscapes[character]);
}
