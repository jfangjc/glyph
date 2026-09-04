import type { BlockType, ParsedBlock } from "../editor/blocks/model";
import type { BlockSource } from "../editor/blocks/rendering";
import type {
    BlockIndexBuilder,
    DocOffset,
    EditorState,
    ProjectionCapability,
    SourceBlock,
    Transaction,
} from "../editor/core/types";

export type DocumentReference = {
    destination: string;
    title?: string;
};

export type DocumentReferenceMap = Record<string, DocumentReference>;

export type DocumentRenderContext = {
    references: DocumentReferenceMap;
    data?: unknown;
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

export type InlineFormatCommand = "bold" | "italic" | "strike" | "code" | "link";

export type BlockFormatCommand =
    | "paragraph"
    | "heading-1"
    | "heading-2"
    | "heading-3"
    | "heading-4"
    | "heading-5"
    | "heading-6"
    | "list"
    | "ordered-list"
    | "todo"
    | "quote"
    | "code";

export type InsertContentCommand = "table" | "image" | "math" | "rule";

export type DocumentFormatDescriptor = {
    id: string;
    label: string;
    extensions: string[];
    defaultExtension: string;
    defaultFileName: string;
    editableTitle: boolean;
};

export type RenderCapability = {
    readReferences?: (blocks: ParsedBlock[]) => DocumentReferenceMap;
    readRenderContext?: (blocks: ParsedBlock[]) => DocumentRenderContext;
    applyRenderContext?: (blocks: HTMLElement[], context: DocumentRenderContext) => void;
    renderDocumentFooter?: (context: DocumentRenderContext) => string;
    readBlockSource?: (block: HTMLElement, type: BlockType, text: string) => BlockSource;
    readInteractiveBlockText?: (type: BlockType, source: string) => string;
    renderInline?: (text: string, context: DocumentRenderContext) => string;
    renderPlainTextContent?: (type: BlockType, text: string) => string | null;
    renderBlock?: (type: BlockType, text: string, context: DocumentRenderContext) => string | null;
    hydrateRenderedContent?: (content: HTMLElement, activeFilePath: string | null) => void;
    plainTextHighlightPolicy?: PlainTextHighlightPolicy;
};

export type EditingCapability = {
    createInsertTextTransaction?: (state: EditorState, text: string) => Transaction;
    createPasteTransaction?: (state: EditorState, text: string) => Transaction;
    createDeleteTransaction?: (
        state: EditorState,
        direction: "backward" | "forward",
        granularity: "grapheme" | "word" | "soft-line" | "hard-line",
    ) => Transaction | null;
    createEnterTransaction?: (state: EditorState, options?: { shiftKey?: boolean }) => Transaction;
    createTabTransaction?: (state: EditorState, delta: -1 | 1) => Transaction | null;
    createInlineFormatTransaction?: (state: EditorState, command: InlineFormatCommand) => Transaction | null;
    createBlockFormatTransaction?: (state: EditorState, command: BlockFormatCommand) => Transaction | null;
    createInsertContentTransaction?: (state: EditorState, command: InsertContentCommand) => Transaction | null;
    createCheckboxToggleTransaction?: (state: EditorState, blockId: string) => Transaction | null;
    createPastedImageSource?: (relativePath: string, originalName: string) => string;
};

export type ClipboardPayload = {
    markdown: string;
    plainText: string;
    html: string;
};

export type ClipboardSelectionContext = {
    state: EditorState;
    from: DocOffset;
    to: DocOffset;
    blocks: SourceBlock[];
    activeFilePath: string | null;
};

export type ClipboardReadResult =
    | { kind: "markdown"; value: string; warning?: string }
    | { kind: "html"; value: string; warning?: string }
    | { kind: "plain"; value: string; warning?: string }
    | { kind: "images"; files: File[] };

export type ClipboardCapability = {
    mimeTypes: string[];
    richHtml: boolean;
    resolveSelectionRange?: (state: EditorState) => { from: DocOffset; to: DocOffset } | null;
    createPayload?: (context: ClipboardSelectionContext) => ClipboardPayload;
    write?: (clipboard: DataTransfer, payload: ClipboardPayload) => void;
    read?: (clipboard: DataTransfer | null | undefined) => ClipboardReadResult | null;
    convertHtml?: (html: string) => string;
};

export type ExportCapability = {
    kind: "pdf";
};

export type DocumentFormat = {
    descriptor: DocumentFormatDescriptor;
    index: { build: BlockIndexBuilder };
    render: RenderCapability;
    editing?: EditingCapability;
    clipboard?: ClipboardCapability;
    projection?: ProjectionCapability;
    preview?: DocumentPreviewBehavior;
    export?: ExportCapability;
};
