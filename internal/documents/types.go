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
