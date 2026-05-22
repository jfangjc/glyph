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

func (*Service) RenameDocument(oldPath string, newPath string) error {
	resolvedOldPath, err := resolveFilePath(oldPath)
	if err != nil {
		return err
	}

	resolvedNewPath, err := resolveFilePath(newPath)
	if err != nil {
		return err
	}

	if resolvedOldPath == resolvedNewPath {
		return nil
	}

	if _, err := os.Stat(resolvedNewPath); err == nil {
		return os.ErrExist
	} else if !os.IsNotExist(err) {
		return err
	}

	return os.Rename(resolvedOldPath, resolvedNewPath)
}
