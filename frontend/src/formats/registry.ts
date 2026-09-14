import { extensionFromPath } from "./file-names";
import { catalog, getCatalogDescriptor, type CatalogEntry } from "./catalog";
import { createLatexDocumentFormat } from "./latex/document";
import { createMarkdownDocumentFormat } from "./markdown/document";
import { createSourceDocumentFormat } from "./source/document";
import type { DocumentFormat, DocumentFormatDescriptor } from "./types";

const specializedFormats: Record<
    NonNullable<CatalogEntry["adapter"]>,
    (descriptor: DocumentFormatDescriptor) => DocumentFormat
> = {
    markdown: createMarkdownDocumentFormat,
    latex: createLatexDocumentFormat,
};

const documentFormats: DocumentFormat[] = catalog.map((entry) => {
    const descriptor = getCatalogDescriptor(entry);
    return entry.adapter
        ? specializedFormats[entry.adapter](descriptor)
        : createSourceDocumentFormat(descriptor);
});

const defaultDocumentFormat = documentFormats.find((format) => format.descriptor.id === "markdown") ?? documentFormats[0];
const fallbackDocumentFormat = documentFormats.find((format) => format.descriptor.id === "plain-text") ?? defaultDocumentFormat;

export function getDocumentFormatById(id: string | null | undefined): DocumentFormat {
    return documentFormats.find((format) => format.descriptor.id === id) ?? defaultDocumentFormat;
}

export function getDocumentFormatForPath(path: string | null | undefined): DocumentFormat {
    const extension = path ? extensionFromPath(path) : "";
    if (!extension) {
        return fallbackDocumentFormat;
    }

    return documentFormats.find((format) => format.descriptor.extensions.includes(extension)) ?? fallbackDocumentFormat;
}
