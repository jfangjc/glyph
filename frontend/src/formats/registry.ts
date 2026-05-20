import { extensionFromPath } from "./file-names";
import { markdownDocumentFormat } from "./markdown/document";
import { createSourceDocumentFormat } from "./source/document";
import type { DocumentFormat } from "./types";

export type DocumentFileFilter = {
    displayName: string;
    patterns: string[];
};

const latexDocumentFormat = createSourceDocumentFormat({
    id: "latex",
    label: "LaTeX",
    extensions: ["tex"],
    defaultExtension: "tex",
    defaultFileName: "Untitled.tex",
});

const orgDocumentFormat = createSourceDocumentFormat({
    id: "org",
    label: "Org Mode",
    extensions: ["org"],
    defaultExtension: "org",
    defaultFileName: "Untitled.org",
});

const typstDocumentFormat = createSourceDocumentFormat({
    id: "typst",
    label: "Typst",
    extensions: ["typ"],
    defaultExtension: "typ",
    defaultFileName: "Untitled.typ",
});

const plainTextDocumentFormat = createSourceDocumentFormat({
    id: "plain-text",
    label: "Plain Text",
    extensions: ["txt", "text"],
    defaultExtension: "txt",
    defaultFileName: "Untitled.txt",
});

export const documentFormats: DocumentFormat[] = [
    markdownDocumentFormat,
    latexDocumentFormat,
    orgDocumentFormat,
    typstDocumentFormat,
    plainTextDocumentFormat,
];

export const defaultDocumentFormat = markdownDocumentFormat;
export const fallbackDocumentFormat = plainTextDocumentFormat;

export function getDocumentFormatById(id: string | null | undefined): DocumentFormat {
    return documentFormats.find((format) => format.id === id) ?? defaultDocumentFormat;
}

export function getDocumentFormatForPath(path: string | null | undefined): DocumentFormat {
    const extension = path ? extensionFromPath(path) : "";
    if (!extension) {
        return fallbackDocumentFormat;
    }

    return documentFormats.find((format) => format.extensions.includes(extension)) ?? fallbackDocumentFormat;
}

export function getDocumentFileFilters(): DocumentFileFilter[] {
    return documentFormats.map((format) => ({
        displayName: format.label,
        patterns: format.extensions.map((extension) => `*.${extension}`),
    }));
}
