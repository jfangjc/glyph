import type { BlockType } from "../../editor/blocks/model";
import type { DocumentFormat, DocumentFormatDescriptor } from "../types";
import { createSourceDocumentFormat } from "../source/document";
import { latexPreviewBehavior } from "./preview";
import { renderLatexSourceHtml } from "./source-highlight";

export function createLatexDocumentFormat(descriptor: DocumentFormatDescriptor): DocumentFormat {
    return createSourceDocumentFormat(descriptor, {
        render: {
            renderPlainTextContent: renderLatexPlainTextContent,
            plainTextHighlightPolicy: {
                liveMaxChars: 8000,
                delayMs: 120,
            },
        },
        preview: latexPreviewBehavior,
    });
}

function renderLatexPlainTextContent(type: BlockType, text: string): string | null {
    return type === "source" ? renderLatexSourceHtml(text) : null;
}
