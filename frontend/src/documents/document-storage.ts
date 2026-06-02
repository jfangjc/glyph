const lastOpenDocumentPathStorageKey = "glyph:last-open-document-path";

export function getLastOpenDocumentPath(): string | null {
    return window.localStorage.getItem(lastOpenDocumentPathStorageKey);
}

export function rememberLastOpenDocumentPath(path: string): void {
    window.localStorage.setItem(lastOpenDocumentPathStorageKey, path);
}

export function forgetLastOpenDocumentPath(): void {
    window.localStorage.removeItem(lastOpenDocumentPathStorageKey);
}
