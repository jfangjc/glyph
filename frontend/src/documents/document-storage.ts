import { readStoredValue, writeStoredValue, removeStoredValue } from "../utils/storage";

const lastOpenDocumentPathStorageKey = "glyph:last-open-document-path";

export function getLastOpenDocumentPath(): string | null {
    return readStoredValue(lastOpenDocumentPathStorageKey);
}

export function rememberLastOpenDocumentPath(path: string): void {
    writeStoredValue(lastOpenDocumentPathStorageKey, path);
}

export function forgetLastOpenDocumentPath(): void {
    removeStoredValue(lastOpenDocumentPathStorageKey);
}
