import catalogJson from "./catalog.json";
import type { DocumentFormatDescriptor } from "./types";

type DocumentFileFilter = {
    displayName: string;
    patterns: string[];
};

export type CatalogEntry = {
    id: string;
    label: string;
    extensions: string[];
    defaultExtension: string;
    defaultFileName: string;
    adapter?: "markdown" | "latex";
    editableTitle: boolean;
};

// Keep adapter validation independent of renderer implementations.
const catalogAdapters = { markdown: true, latex: true };
export const catalog = validateCatalog(catalogJson.formats as CatalogEntry[]);

export function getCatalogDescriptor(entry: CatalogEntry): DocumentFormatDescriptor {
    return {
        id: entry.id,
        label: entry.label,
        extensions: [...entry.extensions],
        defaultExtension: entry.defaultExtension,
        defaultFileName: entry.defaultFileName,
        editableTitle: entry.editableTitle,
    };
}

export function getDocumentFileFilters(): DocumentFileFilter[] {
    return catalog.map((entry) => ({
        displayName: entry.label,
        patterns: entry.extensions.map((extension) => `*.${extension}`),
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
        if (entry.adapter && !(entry.adapter in catalogAdapters)) {
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
