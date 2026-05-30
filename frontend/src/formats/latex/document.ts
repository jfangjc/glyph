import type { BlockType } from "../../editor/blocks/model";
import { createSourceDocumentFormat } from "../source/document";
import { latexPreviewBehavior } from "./preview";
import { renderLatexSourceHtml } from "./source-highlight";

export const latexDocumentFormat = createSourceDocumentFormat({
    id: "latex",
    label: "LaTeX",
    extensions: ["tex"],
    defaultExtension: "tex",
    defaultFileName: "Untitled.tex",
    renderPlainTextContent: renderLatexPlainTextContent,
    previewBehavior: latexPreviewBehavior,
    plainTextHighlightPolicy: {
        liveMaxChars: 8000,
        delayMs: 120,
    },
});

function renderLatexPlainTextContent(type: BlockType, text: string): string | null {
    if (type !== "source") {
        return null;
    }

    return renderLatexSourceHtml(text);
}
