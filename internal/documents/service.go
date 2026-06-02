package documents

type Service struct{}

func (*Service) ReadDocument(path string) (*DocumentFile, error) {
	return readDocument(path)
}

func (*Service) SaveDocument(path string, content string) error {
	return saveDocument(path, content)
}

func (*Service) ReadSiblingPdfPreview(sourcePath string) (*PdfPreviewFile, error) {
	return readSiblingPdfPreview(sourcePath)
}

func (*Service) CreateUntitledMarkdownDocument(baseFilePath string) (*DocumentFile, error) {
	return createUntitledMarkdownDocument(baseFilePath)
}

func (*Service) RenameDocument(oldPath string, newPath string) error {
	return renameDocument(oldPath, newPath)
}

func (*Service) ReadDirectoryTree(path string) (*DirectoryTree, error) {
	return readDirectoryTree(path)
}
