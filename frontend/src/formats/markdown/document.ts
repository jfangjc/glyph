import { buildBlockIndex } from "./block-index";
import {
    createCheckboxToggleTransaction,
    createEnterTransaction,
    createIndentCodeTransaction,
    createIndentListTransaction,
    createInlineFormatTransaction,
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
import { readMarkdownTableCellRange, renderMarkdownBlock } from "./table";
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
            createPayload: createMarkdownClipboardPayload,
            write: (clipboard, source) =>
                writeMarkdownClipboardPayload(clipboard, createMarkdownClipboardPayload(source)),
            read: (clipboard) => readMarkdownClipboardInsert(clipboard)?.markdown ?? null,
            convertHtml: htmlToMarkdown,
        },
        projection: {
            shouldUseNativePointer: (target) => {
                if (target.closest(".markdown-table-preview, .markdown-math-preview, .markdown-html-preview")) {
                    return false;
                }
                return target.closest(".markdown-token-editing") ? true : null;
            },
            resolvePointerSourceOffset: resolveMarkdownPointerSourceOffset,
        },
        export: { kind: "pdf" },
    };
}

function resolveMarkdownPointerSourceOffset(source: string, target: Element, clientX: number): number | null {
    const cell = target.closest<HTMLElement>("[data-table-source-row][data-table-source-column]");
    const lineIndex = cell ? Number(cell.dataset.tableSourceRow) : Number.NaN;
    const cellIndex = cell ? Number(cell.dataset.tableSourceColumn) : Number.NaN;
    if (!cell || !Number.isInteger(lineIndex) || !Number.isInteger(cellIndex)) {
        return null;
    }

    const range = readMarkdownTableCellRange(source, lineIndex, cellIndex);
    if (!range) {
        return null;
    }
    const rect = cell.getBoundingClientRect();
    const progress = rect.width > 0 ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0;
    return range.start + Math.round((range.end - range.start) * progress);
}

function escapeImageAlt(value: string): string {
    return value.replace(/\.[^/.\\]+$/, "").replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}
