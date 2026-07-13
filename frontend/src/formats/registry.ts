import { extensionFromPath } from "./file-names";
import catalogJson from "./catalog.json";
import { createLatexDocumentFormat } from "./latex/document";
import { createMarkdownDocumentFormat } from "./markdown/document";
import { createSourceDocumentFormat } from "./source/document";
import type { DocumentFormat, DocumentFormatDescriptor } from "./types";

type DocumentFileFilter = {
    displayName: string;
    patterns: string[];
};

type CatalogEntry = {
    id: string;
    label: string;
    extensions: string[];
    defaultExtension: string;
    defaultFileName: string;
    adapter?: "markdown" | "latex";
    editableTitle: boolean;
};

const specializedFormats: Record<
    NonNullable<CatalogEntry["adapter"]>,
    (descriptor: DocumentFormatDescriptor) => DocumentFormat
> = {
    markdown: createMarkdownDocumentFormat,
    latex: createLatexDocumentFormat,
};

const catalog = validateCatalog(catalogJson.formats as CatalogEntry[]);
const documentFormats: DocumentFormat[] = catalog.map((entry) => {
    const descriptor: DocumentFormatDescriptor = {
        id: entry.id,
        label: entry.label,
        extensions: [...entry.extensions],
        defaultExtension: entry.defaultExtension,
        defaultFileName: entry.defaultFileName,
        editableTitle: entry.editableTitle,
    };
    return entry.adapter
        ? specializedFormats[entry.adapter](descriptor)
        : createSourceDocumentFormat(descriptor);
});

const defaultDocumentFormat = documentFormats.find((format) => format.descriptor.id === "markdown") ?? documentFormats[0];
const fallbackDocumentFormat = documentFormats.find((format) => format.descriptor.id === "plain-text") ?? defaultDocumentFormat;

export function getDocumentFormats(): DocumentFormat[] {
    return [...documentFormats];
}

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

export function getDocumentFileFilters(): DocumentFileFilter[] {
    return documentFormats.map((format) => ({
        displayName: format.descriptor.label,
        patterns: format.descriptor.extensions.map((extension) => `*.${extension}`),
    }));
}

function validateCatalog(entries: CatalogEntry[]): CatalogEntry[] {
    if (entries.length === 0) {
        throw new Error("The document format catalog is empty");
    }

    const ids = new Set<string>();
    const extensions = new Set<string>();
    return entries.map((entry) => {
        const id = entry.id.trim();
        const defaultExtension = normalizeExtension(entry.defaultExtension);
        const normalizedExtensions = entry.extensions.map(normalizeExtension);
        if (!id || !entry.label.trim() || !entry.defaultFileName.trim() || normalizedExtensions.length === 0) {
            throw new Error(`Invalid document format catalog entry: ${entry.id || "<empty>"}`);
        }
        if (ids.has(id)) {
            throw new Error(`Duplicate document format id: ${id}`);
        }
        ids.add(id);
        for (const extension of normalizedExtensions) {
            if (!extension || extensions.has(extension)) {
                throw new Error(`Duplicate or empty document extension: ${extension || "<empty>"}`);
            }
            extensions.add(extension);
        }
        if (!normalizedExtensions.includes(defaultExtension)) {
            throw new Error(`Default extension ${defaultExtension} is not registered for ${id}`);
        }
        if (entry.adapter && !(entry.adapter in specializedFormats)) {
            throw new Error(`Unknown document format adapter: ${entry.adapter}`);
        }

        return {
            ...entry,
            id,
            label: entry.label.trim(),
            extensions: normalizedExtensions,
            defaultExtension,
            defaultFileName: entry.defaultFileName.trim(),
        };
    });
}

function normalizeExtension(extension: string): string {
    return extension.trim().replace(/^\./, "").toLowerCase();
}
