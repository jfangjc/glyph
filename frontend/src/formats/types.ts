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

export type DocumentEditorHooks = {
    markDocumentDirty: () => void;
    markEditorDirty: () => void;
    syncActiveBlockIndicator: (block: HTMLElement | null) => void;
    syncBlockSourceReveal: (block: HTMLElement | null) => void;
    syncBlockSourceRevealBlocks: (blocks: HTMLElement[]) => void;
};

export type DocumentEditorEventContext = DocumentEditorHooks & {
    isComposingText: boolean;
};

export type DocumentPasteContext = DocumentEditorEventContext & {
    getActiveDocumentFormat: () => DocumentFormat;
    getActiveFilePath: () => string | null;
    ensureDocumentSaved: () => Promise<boolean>;
    runDiscreteEdit: (edit: () => void) => void;
};

export type DocumentEditorBehavior = {
    install?: (hooks: DocumentEditorHooks) => void;
    beforeInput?: (event: InputEvent, context: DocumentEditorEventContext) => boolean;
    input?: (event: Event, context: DocumentEditorEventContext) => boolean;
    keydown?: (event: KeyboardEvent, context: DocumentEditorEventContext) => boolean;
    mouseDown?: (event: MouseEvent, context: DocumentEditorEventContext) => boolean;
    click?: (event: MouseEvent, context: DocumentEditorEventContext) => boolean;
    selectionChange?: (context: DocumentEditorEventContext) => boolean;
    copy?: (event: ClipboardEvent, context: DocumentEditorEventContext) => boolean;
    cut?: (event: ClipboardEvent, context: DocumentEditorEventContext) => boolean;
    paste?: (event: ClipboardEvent, context: DocumentPasteContext) => boolean | Promise<boolean>;
    drop?: (event: DragEvent, context: DocumentPasteContext) => boolean | Promise<boolean>;
    beforeSerialize?: () => void;
};

export type DocumentPreviewContext = {
    activeFilePath: string | null;
    isSavingDocument: boolean;
};

export type DocumentPreviewBehavior = {
    sync: (context: DocumentPreviewContext) => void;
    deactivate: (context: DocumentPreviewContext) => void;
};

export type PlainTextHighlightPolicy = {
    liveMaxChars: number;
    delayMs: number;
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
    renderPlainTextContent?: (type: BlockType, text: string) => string | null;
    renderBlock?: (type: BlockType, text: string, references: DocumentReferenceMap) => string | null;
    hydrateRenderedContent?: (content: HTMLElement, activeFilePath: string | null) => void;
    editorBehavior?: DocumentEditorBehavior;
    previewBehavior?: DocumentPreviewBehavior;
    clipboardMimeTypes?: string[];
    plainTextHighlightPolicy?: PlainTextHighlightPolicy;
};
