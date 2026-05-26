import { Call, Events } from "@wailsio/runtime";

const openDocumentRequestedEvent = "glyph:open-document-requested";

export function takePendingOpenDocumentPaths(): Promise<string[]> {
    return Call.ByName("glyph/internal/launch.Service.TakePendingOpenDocumentPaths") as Promise<string[]>;
}

export function onOpenDocumentRequested(callback: () => void): () => void {
    return Events.On(openDocumentRequestedEvent, callback);
}
