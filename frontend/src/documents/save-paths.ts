import { titleFromFileName } from "../formats/file-names";
import { fileNameFromPath } from "../utils/text";

export function resolveEditedActiveFilePath(
    activeFilePath: string,
    title: string,
    defaultExtension: string,
): string {
    const currentFileName = fileNameFromPath(activeFilePath);
    const normalizedTitle = title.trim();

    if (!normalizedTitle || normalizedTitle === titleFromFileName(currentFileName)) {
        return activeFilePath;
    }

    const extension = readFileExtension(currentFileName) ?? defaultExtension;
    const nextFileName = normalizeSuggestedFileName(sanitizeFileNameBase(normalizedTitle), extension);
    const separatorIndex = Math.max(activeFilePath.lastIndexOf("\\"), activeFilePath.lastIndexOf("/"));

    return separatorIndex >= 0 ? `${activeFilePath.slice(0, separatorIndex + 1)}${nextFileName}` : nextFileName;
}

export function normalizeSuggestedFileName(value: string, defaultExtension: string): string {
    const trimmed = value.trim() || "Untitled";

    if (/[\\/]$/.test(trimmed)) {
        return `Untitled.${defaultExtension}`;
    }

    return /\.[^\\/.\s]+$/.test(trimmed) ? trimmed : `${trimmed}.${defaultExtension}`;
}

export function areSamePath(left: string, right: string): boolean {
    return normalizeComparablePath(left) === normalizeComparablePath(right);
}

function sanitizeFileNameBase(value: string): string {
    return value
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
        .replace(/\s+/g, " ")
        .replace(/[. ]+$/g, "")
        .slice(0, 80)
        .trim();
}

function readFileExtension(fileName: string): string | null {
    const extensionMatch = fileName.match(/\.([^\\/.\s]+)$/);
    return extensionMatch?.[1] ?? null;
}

function normalizeComparablePath(path: string): string {
    return path.replace(/\\/g, "/").toLowerCase();
}
