import type { ParsedBlock, ParsedDocument } from "../../editor/block-model";
import { titleFromFileName } from "../file-names";
import type { DocumentFileLike, DocumentFormat, ParsedDocumentFragment } from "../types";

type SourceDocumentFormatOptions = {
    id: string;
    label: string;
    extensions: string[];
    defaultExtension: string;
    defaultFileName: string;
};

export function createSourceDocumentFormat(options: SourceDocumentFormatOptions): DocumentFormat {
    return {
        ...options,
        supportsTitle: false,
        parseDocument: parseSourceDocument,
        parseFragment: parseSourceFragment,
        serializeDocument: serializeSourceDocument,
    };
}

function parseSourceDocument(documentFile: DocumentFileLike): ParsedDocument {
    return {
        title: titleFromFileName(documentFile.name),
        usesTitle: false,
        blocks: [{ type: "source", text: normalizeSourceContent(documentFile.content) }],
        references: {},
    };
}

function parseSourceFragment(content: string): ParsedDocumentFragment {
    return {
        blocks: [{ type: "source", text: normalizeSourceContent(content) }],
        references: {},
    };
}

function serializeSourceDocument(_title: string, _usesTitle: boolean, blocks: ParsedBlock[]): string {
    return blocks.map((block) => block.text).join("\n");
}

function normalizeSourceContent(content: string): string {
    return content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}
