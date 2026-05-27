export type BlockType =
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
    | "code"
    | "source"
    | "rule"
    | "table"
    | "math"
    | "html"
    | "reference";

export type ParsedBlock = {
    type: BlockType;
    text: string;
    indent?: number;
    checked?: boolean;
    codeFence?: string;
    codeInfo?: string;
    listMarker?: string;
    listNumber?: string;
    quoteLevel?: number;
    ruleMarker?: string;
    mathSource?: string;
};

export type ParsedDocument = {
    title: string;
    usesTitle: boolean;
    blocks: ParsedBlock[];
    references?: Record<string, { destination: string; title?: string }>;
};

export const blockLabels: Record<BlockType, string> = {
    paragraph: "Paragraph",
    "heading-1": "Heading 1",
    "heading-2": "Heading 2",
    "heading-3": "Heading 3",
    "heading-4": "Heading 4",
    "heading-5": "Heading 5",
    "heading-6": "Heading 6",
    list: "List item",
    "ordered-list": "Ordered list item",
    todo: "Todo",
    quote: "Quote",
    code: "Code",
    source: "Source",
    rule: "Horizontal rule",
    table: "Table",
    math: "Math",
    html: "HTML",
    reference: "Reference",
};

export const headingTypes = new Set<BlockType>([
    "heading-1",
    "heading-2",
    "heading-3",
    "heading-4",
    "heading-5",
    "heading-6",
]);

export function readBlockType(value: string | undefined): BlockType {
    if (value && value in blockLabels) {
        return value as BlockType;
    }

    return "paragraph";
}
