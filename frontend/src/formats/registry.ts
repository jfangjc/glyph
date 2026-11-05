import { catalog } from "./catalog";
import { createFormatRegistry, type FormatAdapter } from "./format-registry";
import { createLatexDocumentFormat } from "./latex/document";
import { createMarkdownDocumentFormat } from "./markdown/document";
import { createOrgDocumentFormat } from "./org/document";
import { createTypstDocumentFormat } from "./typst/document";

const adapters = {
    markdown: createMarkdownDocumentFormat,
    latex: createLatexDocumentFormat,
    org: createOrgDocumentFormat,
    typst: createTypstDocumentFormat,
} satisfies Record<string, FormatAdapter>;

const registry = createFormatRegistry(catalog, adapters, {
    defaultFormatId: "markdown",
    fallbackFormatId: "plain-text",
});

export const getDocumentFormats = registry.getAll;
export const getDocumentFormatById = registry.getById;
export const getDocumentFormatForPath = registry.getForPath;
