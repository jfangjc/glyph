import { createSourceDocumentFormat } from "../source/document";
import type { DocumentFormat, DocumentFormatDescriptor } from "../types";

// A dedicated registration point for Typst highlighting and compiled preview.
// Source remains the document model when those capabilities are added.
export function createTypstDocumentFormat(descriptor: DocumentFormatDescriptor): DocumentFormat {
    return createSourceDocumentFormat(descriptor);
}
