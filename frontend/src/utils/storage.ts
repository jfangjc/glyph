// Restoring a recent file is optional. Disabled or full storage must not
// interrupt opening, saving, or switching documents.
export function readStoredValue(key: string): string | null {
    try { return window.localStorage.getItem(key); }
    catch { return null; }
}

export function writeStoredValue(key: string, value: string): void {
    try { window.localStorage.setItem(key, value); }
    catch { /* The document itself is still saved on disk. */ }
}

export function removeStoredValue(key: string): void {
    try { window.localStorage.removeItem(key); }
    catch { /* Unavailable storage has no recent path to restore. */ }
}
