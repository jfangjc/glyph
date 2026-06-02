package documents

import (
	"os"
	"path/filepath"
	"strconv"
)

func readDocument(path string) (*DocumentFile, error) {
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

func saveDocument(path string, content string) error {
	resolvedPath, err := resolveFilePath(path)
	if err != nil {
		return err
	}

	return os.WriteFile(resolvedPath, []byte(content), 0o644)
}

func createUntitledMarkdownDocument(baseFilePath string) (*DocumentFile, error) {
	resolvedBasePath, err := resolveFilePath(baseFilePath)
	if err != nil {
		return nil, err
	}

	dir := filepath.Dir(resolvedBasePath)
	path, err := createUniqueUntitledMarkdownFile(dir)
	if err != nil {
		return nil, err
	}

	return &DocumentFile{
		Path:    path,
		Name:    filepath.Base(path),
		Content: "",
	}, nil
}

func renameDocument(oldPath string, newPath string) error {
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

func createUniqueUntitledMarkdownFile(dir string) (string, error) {
	for index := 0; ; index++ {
		name := "Untitled.md"
		if index > 0 {
			name = "Untitled " + strconv.Itoa(index+1) + ".md"
		}

		path := filepath.Join(dir, name)
		file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o644)
		if err == nil {
			return path, file.Close()
		}

		if !os.IsExist(err) {
			return "", err
		}
	}
}
