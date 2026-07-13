import type { BlockIndex, BlockIndexBuildContext } from "../../editor/core/types";
import type {
    DocumentFormat,
    DocumentFormatDescriptor,
    DocumentPreviewBehavior,
    RenderCapability,
} from "../types";

type SourceDocumentCapabilities = {
    render?: RenderCapability;
    preview?: DocumentPreviewBehavior;
};

export function createSourceDocumentFormat(
    descriptor: DocumentFormatDescriptor,
    capabilities: SourceDocumentCapabilities = {},
): DocumentFormat {
    return {
        descriptor,
        index: { build: buildSourceBlockIndex },
        render: capabilities.render ?? {},
        preview: capabilities.preview,
        clipboard: {
            mimeTypes: ["text/plain"],
            richHtml: false,
        },
    };
}

function buildSourceBlockIndex(source: string, context?: BlockIndexBuildContext): BlockIndex {
    const previous = context?.previous.blocks[0];
    return {
        blocks: [{
            id: previous?.type === "source" ? previous.id : "source-document",
            type: "source",
            text: source,
            sourceFrom: 0,
            sourceTo: source.length,
            contentFrom: 0,
            contentTo: source.length,
            lineFrom: 0,
            lineTo: Math.max(0, source.split("\n").length - 1),
        }],
    };
}
