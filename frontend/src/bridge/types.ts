export type DocumentFile = {
    path: string;
    name: string;
    content: string;
};

export type ImageFile = {
    path: string;
    mimeType: string;
    dataUrl: string;
};

export type PdfPreviewFile = {
    path: string;
    mimeType: string;
    dataUrl: string;
};

export type PastedImageFile = {
    path: string;
    relativePath: string;
};

export type DirectoryTree = {
    path: string;
    name: string;
    children: DirectoryTreeItem[];
};

export type DirectoryTreeItem = {
    path: string;
    name: string;
    isDir: boolean;
    children?: DirectoryTreeItem[];
};
