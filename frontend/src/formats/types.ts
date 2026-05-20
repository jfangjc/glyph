import type { BlockType, ParsedBlock, ParsedDocument } from "../editor/blocks/model";
import type { BlockSource } from "../editor/blocks/rendering";

export type DocumentFileLike = {
    name: string;
    content: string;
};

export type DocumentReference = {
    destination: string;
    title?: string;
};

export type DocumentReferenceMap = Record<string, DocumentReference>;

export type ParsedDocumentFragment = {
    blocks: ParsedBlock[];
    references?: DocumentReferenceMap;
};

export type DocumentFormat = {
    id: string;
    label: string;
    extensions: string[];
    defaultExtension: string;
    defaultFileName: string;
    supportsTitle: boolean;
    parseDocument: (documentFile: DocumentFileLike) => ParsedDocument;
    parseFragment: (content: string) => ParsedDocumentFragment;
    serializeDocument: (title: string, usesTitle: boolean, blocks: ParsedBlock[]) => string;
    readReferences?: (blocks: ParsedBlock[]) => DocumentReferenceMap;
    hasBlockSource?: (type: BlockType) => boolean;
    readBlockSource?: (block: HTMLElement, type: BlockType, text: string) => BlockSource;
    renderInline?: (text: string, references: DocumentReferenceMap) => string;
    hydrateRenderedContent?: (content: HTMLElement, activeFilePath: string | null) => void;
};
