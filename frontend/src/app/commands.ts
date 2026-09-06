import type { AppMenuCommand } from "./keymap";
import type { EditorCommand } from "../editor/controllers/editor-input-controller";
export type CommandMetadata = { id: AppMenuCommand; label: string; group: string; editor?: EditorCommand };
export const commands: CommandMetadata[] = [
    {
        id: "file:new",
        label: "New",
        group: "File",
    },
    {
        id: "file:open",
        label: "Open File",
        group: "File",
    },
    {
        id: "file:open-directory",
        label: "Open Directory",
        group: "File",
    },
    {
        id: "file:save",
        label: "Save",
        group: "File",
    },
    {
        id: "file:save-as",
        label: "Save As",
        group: "File",
    },
    {
        id: "file:export",
        label: "Export PDF",
        group: "File",
    },
    {
        id: "edit:undo",
        label: "Undo",
        group: "Edit",
    },
    {
        id: "edit:redo",
        label: "Redo",
        group: "Edit",
    },
    {
        id: "edit:cut",
        label: "Cut",
        group: "Edit",
    },
    {
        id: "edit:copy",
        label: "Copy",
        group: "Edit",
    },
    {
        id: "edit:paste",
        label: "Paste",
        group: "Edit",
    },
    {
        id: "edit:select-all",
        label: "Select All",
        group: "Edit",
    },
    {
        id: "edit:find",
        label: "Find",
        group: "Edit",
    },
    {
        id: "edit:replace",
        label: "Replace",
        group: "Edit",
    },
    {
        id: "view:toggle-markdown-source",
        label: "Markdown Source Mode",
        group: "View",
    },
    {
        id: "view:toggle-file-tree",
        label: "Toggle File Tree",
        group: "View",
    },
    {
        id: "view:zoom-in",
        label: "Zoom In",
        group: "View",
    },
    {
        id: "view:zoom-out",
        label: "Zoom Out",
        group: "View",
    },
    {
        id: "view:zoom-reset",
        label: "Reset Zoom",
        group: "View",
    },
    {
        id: "format:bold",
        label: "Bold",
        group: "Formatting",
        editor: "bold",
    },
    {
        id: "format:italic",
        label: "Italic",
        group: "Formatting",
        editor: "italic",
    },
    {
        id: "format:strike",
        label: "Strikethrough",
        group: "Formatting",
        editor: "strike",
    },
    {
        id: "format:inline-code",
        label: "Inline Code",
        group: "Formatting",
        editor: "inline-code",
    },
    {
        id: "format:link",
        label: "Link",
        group: "Formatting",
        editor: "link",
    },
    {
        id: "format:block:paragraph",
        label: "Paragraph",
        group: "Formatting",
        editor: "block:paragraph",
    },
    {
        id: "format:block:heading-1",
        label: "Heading 1",
        group: "Formatting",
        editor: "block:heading-1",
    },
    {
        id: "format:block:heading-2",
        label: "Heading 2",
        group: "Formatting",
        editor: "block:heading-2",
    },
    {
        id: "format:block:heading-3",
        label: "Heading 3",
        group: "Formatting",
        editor: "block:heading-3",
    },
    {
        id: "format:block:list",
        label: "Bulleted List",
        group: "Formatting",
        editor: "block:list",
    },
    {
        id: "format:block:ordered-list",
        label: "Numbered List",
        group: "Formatting",
        editor: "block:ordered-list",
    },
    {
        id: "format:block:todo",
        label: "Todo",
        group: "Formatting",
        editor: "block:todo",
    },
    {
        id: "format:block:quote",
        label: "Quote",
        group: "Formatting",
        editor: "block:quote",
    },
    {
        id: "format:block:code",
        label: "Code Block",
        group: "Formatting",
        editor: "block:code",
    },
    {
        id: "insert:table",
        label: "Table",
        group: "Insert",
        editor: "insert:table",
    },
    {
        id: "insert:image",
        label: "Image",
        group: "Insert",
        editor: "insert:image",
    },
    {
        id: "insert:math",
        label: "Math",
        group: "Insert",
        editor: "insert:math",
    },
    {
        id: "insert:rule",
        label: "Horizontal Rule",
        group: "Insert",
        editor: "insert:rule",
    },
    {
        id: "help:about",
        label: "About Glyph",
        group: "Help",
    },
];
