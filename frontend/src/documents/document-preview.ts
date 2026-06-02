import type { DocumentFormat, DocumentPreviewBehavior, DocumentPreviewContext } from "../formats/types";

let activePreviewBehavior: DocumentPreviewBehavior | null = null;

export function syncDocumentPreview(format: DocumentFormat, context: DocumentPreviewContext): void {
    if (activePreviewBehavior && activePreviewBehavior !== format.previewBehavior) {
        activePreviewBehavior.deactivate(context);
    }

    activePreviewBehavior = format.previewBehavior ?? null;
    activePreviewBehavior?.sync(context);
}
