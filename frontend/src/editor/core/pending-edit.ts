type PendingEdit = { flush: () => void; cancel: () => void; isDirty: () => boolean };

let pendingEdit: PendingEdit | null = null;

export function registerPendingEdit(edit: PendingEdit): () => void {
    pendingEdit?.flush();
    pendingEdit = edit;
    return () => { if (pendingEdit === edit) pendingEdit = null; };
}

export function flushPendingEdit(): void { pendingEdit?.flush(); }
export function cancelPendingEdit(): void { pendingEdit?.cancel(); }
export function hasPendingEdit(): boolean { return pendingEdit !== null; }
export function hasDirtyPendingEdit(): boolean { return pendingEdit?.isDirty() ?? false; }
