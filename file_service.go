package main

import (
	"errors"
	"os"
	"path/filepath"
)

type DocumentFile struct {
	Path    string `json:"path"`
	Name    string `json:"name"`
	Content string `json:"content"`
}

type FileService struct{}

func (*FileService) ReadFile(path string) (*DocumentFile, error) {
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

func (*FileService) SaveFile(path string, content string) error {
	resolvedPath, err := resolveFilePath(path)
	if err != nil {
		return err
	}

	return os.WriteFile(resolvedPath, []byte(content), 0o644)
}

func resolveFilePath(path string) (string, error) {
	if path == "" {
		return "", errors.New("file path is required")
	}

	return filepath.Abs(path)
}
