import type { BlockType } from "../../editor/block-model";

export type MarkdownShortcut = {
    marker: string;
    type: BlockType;
    indent?: number;
};

export const markdownShortcuts: MarkdownShortcut[] = [
    { marker: "###### ", type: "heading-6" },
    { marker: "##### ", type: "heading-5" },
    { marker: "#### ", type: "heading-4" },
    { marker: "### ", type: "heading-3" },
    { marker: "# ", type: "heading-1" },
    { marker: "## ", type: "heading-2" },
    { marker: "    - ", type: "list", indent: 2 },
    { marker: "  - ", type: "list", indent: 1 },
    { marker: "- [ ] ", type: "todo" },
    { marker: "- ", type: "list" },
    { marker: "> ", type: "quote" },
    { marker: "[ ] ", type: "todo" },
    { marker: "```", type: "code" },
];
