import type { BlockType } from "../../editor/block-model";

export type MarkdownShortcut = {
    marker: string;
    type: BlockType;
    indent?: number;
    exact?: boolean;
    listMarker?: string;
    listNumber?: string;
};

export const markdownShortcuts: MarkdownShortcut[] = [
    { marker: "###### ", type: "heading-6" },
    { marker: "##### ", type: "heading-5" },
    { marker: "#### ", type: "heading-4" },
    { marker: "### ", type: "heading-3" },
    { marker: "# ", type: "heading-1" },
    { marker: "## ", type: "heading-2" },
    { marker: "        1. ", type: "ordered-list", indent: 2, listNumber: "1" },
    { marker: "    1. ", type: "ordered-list", indent: 1, listNumber: "1" },
    { marker: "  1. ", type: "ordered-list", indent: 1, listNumber: "1" },
    { marker: "1. ", type: "ordered-list", listNumber: "1" },
    { marker: "        - ", type: "list", indent: 2, listMarker: "-" },
    { marker: "        * ", type: "list", indent: 2, listMarker: "*" },
    { marker: "        + ", type: "list", indent: 2, listMarker: "+" },
    { marker: "    - ", type: "list", indent: 1, listMarker: "-" },
    { marker: "    * ", type: "list", indent: 1, listMarker: "*" },
    { marker: "    + ", type: "list", indent: 1, listMarker: "+" },
    { marker: "  - ", type: "list", indent: 1 },
    { marker: "  * ", type: "list", indent: 1, listMarker: "*" },
    { marker: "  + ", type: "list", indent: 1, listMarker: "+" },
    { marker: "- [ ] ", type: "todo", listMarker: "-" },
    { marker: "* [ ] ", type: "todo", listMarker: "*" },
    { marker: "+ [ ] ", type: "todo", listMarker: "+" },
    { marker: "- ", type: "list", listMarker: "-" },
    { marker: "* ", type: "list", listMarker: "*" },
    { marker: "+ ", type: "list", listMarker: "+" },
    { marker: "> ", type: "quote" },
    { marker: "[ ] ", type: "todo" },
    { marker: "---", type: "rule", exact: true },
    { marker: "***", type: "rule", exact: true },
    { marker: "___", type: "rule", exact: true },
];
