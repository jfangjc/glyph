import type { DocumentFormat, DocumentPreviewBehavior, DocumentPreviewContext } from "../formats/types";

let activePreviewBehavior: DocumentPreviewBehavior | null = null;

export function syncDocumentPreview(format: DocumentFormat, context: DocumentPreviewContext): void {
    if (activePreviewBehavior && activePreviewBehavior !== format.preview) {
        activePreviewBehavior.deactivate(context);
    }

    activePreviewBehavior = format.preview ?? null;
    activePreviewBehavior?.sync(context);
}
