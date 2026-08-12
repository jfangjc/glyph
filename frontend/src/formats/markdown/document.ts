import { buildBlockIndex } from "./block-index";
import {
    createCheckboxToggleTransaction,
    createDeleteTransaction,
    createEnterTransaction,
    createIndentCodeTransaction,
    createIndentListTransaction,
    createInsertTextTransaction,
    createInlineFormatTransaction,
    createPasteTransaction,
    readSelectedSourceRange,
    createTableTabTransaction,
} from "./commands";
import type { DocumentFormat, DocumentFormatDescriptor } from "../types";
import { hasMarkdownBlockSource, readMarkdownBlockSource } from "./block-source";
import { hydrateMarkdownImagePreviews } from "./images";
import { renderInlineMarkdown } from "./inline";
import { readMarkdownReferences } from "./parse";
import {
    applyMarkdownRenderContext,
    readMarkdownRenderContext,
    renderExtendedMarkdownBlock,
    renderMarkdownDocumentFooter,
} from "./render-context";
import { renderMarkdownBlock } from "./table";
import {
    createMarkdownClipboardPayload,
    htmlToMarkdown,
    readMarkdownClipboardInsert,
    writeMarkdownClipboardPayload,
} from "./clipboard";
import { readMathSourceText } from "./math";

export function createMarkdownDocumentFormat(descriptor: DocumentFormatDescriptor): DocumentFormat {
    return {
        descriptor,
        index: { build: buildBlockIndex },
        render: {
            readReferences: readMarkdownReferences,
            readRenderContext: readMarkdownRenderContext,
            applyRenderContext: applyMarkdownRenderContext,
            renderDocumentFooter: renderMarkdownDocumentFooter,
            hasBlockSource: hasMarkdownBlockSource,
            readBlockSource: readMarkdownBlockSource,
            readInteractiveBlockText: (type, source) => type === "math" ? readMathSourceText(source) : source,
            renderInline: renderInlineMarkdown,
            renderBlock: (type, text, context) =>
                renderMarkdownBlock(type, text, context, renderInlineMarkdown)
                ?? renderExtendedMarkdownBlock(type, text, context),
            hydrateRenderedContent: hydrateMarkdownImagePreviews,
        },
        editing: {
            createInsertTextTransaction,
            createPasteTransaction,
            createDeleteTransaction,
            createEnterTransaction,
            createTabTransaction: (state, delta) =>
                createTableTabTransaction(state, delta)
                ?? createIndentListTransaction(state, delta)
                ?? createIndentCodeTransaction(state, delta),
            createInlineFormatTransaction,
            createCheckboxToggleTransaction,
            createPastedImageSource: (relativePath, originalName) =>
                `![${escapeImageAlt(originalName)}](${relativePath})`,
        },
        clipboard: {
            mimeTypes: ["text/markdown"],
            richHtml: true,
            resolveSelectionRange: readSelectedSourceRange,
            createPayload: createMarkdownClipboardPayload,
            write: writeMarkdownClipboardPayload,
            read: readMarkdownClipboardInsert,
            convertHtml: htmlToMarkdown,
        },
        projection: {
            shouldUseNativePointer: (target) => {
                if (target.closest("button, input, textarea, select")) {
                    return true;
                }
                if (target.closest(".markdown-token-editing")) {
                    return true;
                }
                if (target.closest(".format-block-preview, .markdown-image-token, .markdown-math-token")) {
                    return false;
                }
                return null;
            },
        },
        export: { kind: "pdf" },
    };
}

function escapeImageAlt(value: string): string {
    return value.replace(/\.[^/.\\]+$/, "").replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}
