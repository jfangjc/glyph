export function titleFromFileName(fileName: string): string {
    const normalized = fileName.replace(/\\/g, "/");
    const baseName = normalized.slice(normalized.lastIndexOf("/") + 1) || "Untitled";
    const extensionIndex = baseName.lastIndexOf(".");
    const title = extensionIndex > 0 ? baseName.slice(0, extensionIndex) : baseName;

    return title || "Untitled";
}

export function extensionFromPath(path: string): string {
    const normalized = path.replace(/\\/g, "/");
    const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);
    const extensionIndex = fileName.lastIndexOf(".");

    return extensionIndex >= 0 ? fileName.slice(extensionIndex + 1).toLowerCase() : "";
}
