import { extensionFromPath } from "./file-names";
import { latexDocumentFormat } from "./latex/document";
import { markdownDocumentFormat } from "./markdown/document";
import { createSourceDocumentFormat } from "./source/document";
import type { DocumentFormat } from "./types";

type DocumentFileFilter = {
    displayName: string;
    patterns: string[];
};

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

const documentFormats: DocumentFormat[] = [
    markdownDocumentFormat,
    latexDocumentFormat,
    orgDocumentFormat,
    typstDocumentFormat,
    plainTextDocumentFormat,
];

const defaultDocumentFormat = markdownDocumentFormat;
const fallbackDocumentFormat = plainTextDocumentFormat;

export function getDocumentFormats(): DocumentFormat[] {
    return [...documentFormats];
}

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
