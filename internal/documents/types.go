package documents

type DocumentFile struct {
	Path    string `json:"path"`
	Name    string `json:"name"`
	Content string `json:"content"`
}

type ImageFile struct {
	Path     string `json:"path"`
	MimeType string `json:"mimeType"`
	DataURL  string `json:"dataUrl"`
}

type PastedImageFile struct {
	Path         string `json:"path"`
	RelativePath string `json:"relativePath"`
}

type DirectoryTree struct {
	Path     string               `json:"path"`
	Name     string               `json:"name"`
	Children []*DirectoryTreeItem `json:"children"`
}

type DirectoryTreeItem struct {
	Path     string               `json:"path"`
	Name     string               `json:"name"`
	IsDir    bool                 `json:"isDir"`
	Children []*DirectoryTreeItem `json:"children,omitempty"`
}
