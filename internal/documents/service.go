package documents

import (
	"os"
	"path/filepath"
)

type Service struct{}

func (*Service) ReadDocument(path string) (*DocumentFile, error) {
	resolvedPath, err := resolveFilePath(path)
	if err != nil {
		return nil, err
	}

	content, err := os.ReadFile(resolvedPath)
	if err != nil {
		return nil, err
	}

	return &DocumentFile{
		Path:    resolvedPath,
		Name:    filepath.Base(resolvedPath),
		Content: string(content),
	}, nil
}

func (*Service) SaveDocument(path string, content string) error {
	resolvedPath, err := resolveFilePath(path)
	if err != nil {
		return err
	}

	return os.WriteFile(resolvedPath, []byte(content), 0o644)
}
