import type { DocumentFormat } from "../types";
import { hasMarkdownBlockSource, readMarkdownBlockSource } from "./block-source";
import { hydrateMarkdownImagePreviews } from "./images";
import { renderInlineMarkdown } from "./inline";
import {
    parseMarkdownDocument,
    parseMarkdownFragment as parseMarkdownFragmentImpl,
    readMarkdownReferences,
} from "./parse";
import {
    applyMarkdownRenderContext,
    readMarkdownRenderContext,
    renderExtendedMarkdownBlock,
    renderMarkdownDocumentFooter,
} from "./render-context";
import { serializeMarkdownDocument } from "./serialize";
import { renderMarkdownBlock } from "./table";
import { markdownEditorBehavior } from "./editor/behavior";

export { parseMarkdownFragment } from "./parse";

export const markdownDocumentFormat: DocumentFormat = {
    id: "markdown",
    label: "Markdown",
    extensions: ["md", "markdown"],
    defaultExtension: "md",
    defaultFileName: "Untitled.md",
    supportsTitle: true,
    parseDocument: parseMarkdownDocument,
    parseFragment: parseMarkdownFragmentImpl,
    serializeDocument: serializeMarkdownDocument,
    readReferences: readMarkdownReferences,
    readRenderContext: readMarkdownRenderContext,
    applyRenderContext: applyMarkdownRenderContext,
    renderDocumentFooter: renderMarkdownDocumentFooter,
    hasBlockSource: hasMarkdownBlockSource,
    readBlockSource: readMarkdownBlockSource,
    renderInline: renderInlineMarkdown,
    renderBlock: (type, text, context) => renderMarkdownBlock(type, text, context, renderInlineMarkdown) ?? renderExtendedMarkdownBlock(type, text, context),
    hydrateRenderedContent: hydrateMarkdownImagePreviews,
    editorBehavior: markdownEditorBehavior,
    clipboardMimeTypes: ["text/markdown"],
};
