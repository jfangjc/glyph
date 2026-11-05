import { validateCatalog, getCatalogDescriptor, type CatalogEntry } from "./catalog";
import { extensionFromPath } from "./file-names";
import { createSourceDocumentFormat } from "./source/document";
import type { DocumentFormat, DocumentFormatDescriptor } from "./types";

export type FormatAdapter = (descriptor: DocumentFormatDescriptor) => DocumentFormat;

/** Registration is independent of built-in renderers and the desktop runtime. */
export function createFormatRegistry(
    entries: readonly CatalogEntry[],
    adapters: Readonly<Record<string, FormatAdapter>>,
    options: { defaultFormatId: string; fallbackFormatId: string },
) {
    const byId = new Map<string, DocumentFormat>();
    const byExtension = new Map<string, DocumentFormat>();
    for (const entry of validateCatalog(entries)) {
        const descriptor = getCatalogDescriptor(entry);
        if (entry.adapter && !Object.hasOwn(adapters, entry.adapter)) {
            throw new Error(`No adapter registered for format ${entry.id}: ${entry.adapter}`);
        }
        const format = entry.adapter ? adapters[entry.adapter](descriptor) : createSourceDocumentFormat(descriptor);
        if (format.descriptor.id !== descriptor.id) {
            throw new Error(`Adapter for ${entry.id} must preserve its catalog descriptor`);
        }
        byId.set(entry.id, format);
        for (const extension of descriptor.extensions) byExtension.set(extension, format);
    }
    const defaultFormat = byId.get(options.defaultFormatId);
    const fallbackFormat = byId.get(options.fallbackFormatId);
    if (!defaultFormat || !fallbackFormat) {
        throw new Error("Default and fallback formats must be registered");
    }
    return {
        getAll: (): readonly DocumentFormat[] => [...byId.values()],
        getById: (id: string | null | undefined): DocumentFormat => byId.get(id ?? "") ?? defaultFormat,
        getForPath: (path: string | null | undefined): DocumentFormat =>
            byExtension.get(extensionFromPath(path ?? "")) ?? fallbackFormat,
    };
}
