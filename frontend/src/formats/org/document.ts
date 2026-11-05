import { createSourceDocumentFormat } from "../source/document";
import type { DocumentFormat, DocumentFormatDescriptor } from "../types";

// Keep Org syntax literal until its own index, editing and render capabilities
// are implemented. Markdown parsing must never rewrite Org document source.
export function createOrgDocumentFormat(descriptor: DocumentFormatDescriptor): DocumentFormat {
    return createSourceDocumentFormat(descriptor);
}
