import type { DocumentFormat, DocumentPreviewBehavior, DocumentPreviewContext } from "../formats/types";
import { documentState } from "./document-state";

export function createDocumentPreviewController() {
    let active: DocumentPreviewBehavior | null = null;
    let previous: DocumentPreviewContext | null = null;
    return {
        sync(format: DocumentFormat, context: DocumentPreviewContext): void {
            if (active && previous && (active !== format.preview || previous.sessionId !== context.sessionId)) {
                active.deactivate(previous);
            }
            active = format.preview ?? null;
            previous = { ...context };
            active?.sync(context);
        },
        saved(context: DocumentPreviewContext): void {
            if (previous?.sessionId === context.sessionId && previous.activeFilePath === context.activeFilePath) active?.onSaved?.(context);
        },
    };
}

const controller = createDocumentPreviewController();
let eventsInstalled = false;

function readContext(): DocumentPreviewContext {
    const { sessionId, activeFilePath, isSavingDocument, hasUnsavedChanges } = documentState;
    return { sessionId, activeFilePath, isSavingDocument, hasUnsavedChanges };
}

export function installDocumentPreviewEvents(): void {
    if (eventsInstalled) return;
    eventsInstalled = true;
    window.addEventListener("glyph:document-saved", () => controller.saved(readContext()));
}

export function syncDocumentPreview(format: DocumentFormat): void {
    controller.sync(format, readContext());
}
