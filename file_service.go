package main

import (
	"encoding/base64"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

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

func (*FileService) ReadImage(path string, baseFilePath string) (*ImageFile, error) {
	resolvedPath, err := resolveLocalAssetPath(path, baseFilePath)
	if err != nil {
		return nil, err
	}

	content, err := os.ReadFile(resolvedPath)
	if err != nil {
		return nil, err
	}

	mimeType := mime.TypeByExtension(strings.ToLower(filepath.Ext(resolvedPath)))
	if mimeType == "" {
		mimeType = http.DetectContentType(content)
	}

	if !strings.HasPrefix(mimeType, "image/") {
		return nil, fmt.Errorf("%s is not an image", resolvedPath)
	}

	return &ImageFile{
		Path:     resolvedPath,
		MimeType: mimeType,
		DataURL:  "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(content),
	}, nil
}

func resolveFilePath(path string) (string, error) {
	if path == "" {
		return "", errors.New("file path is required")
	}

	return filepath.Abs(path)
}

func resolveLocalAssetPath(path string, baseFilePath string) (string, error) {
	if path == "" {
		return "", errors.New("image path is required")
	}

	localPath, err := normalizeLocalPath(path)
	if err != nil {
		return "", err
	}

	if filepath.IsAbs(localPath) {
		return filepath.Abs(localPath)
	}

	if baseFilePath == "" {
		return filepath.Abs(localPath)
	}

	resolvedBasePath, err := filepath.Abs(baseFilePath)
	if err != nil {
		return "", err
	}

	return filepath.Abs(filepath.Join(filepath.Dir(resolvedBasePath), localPath))
}

func normalizeLocalPath(path string) (string, error) {
	if runtime.GOOS == "windows" && isWindowsAbsolutePath(path) {
		return path, nil
	}

	parsedURL, err := url.Parse(path)
	if err != nil {
		return "", err
	}

	if parsedURL.Scheme == "" {
		return path, nil
	}

	if parsedURL.Scheme != "file" {
		return "", fmt.Errorf("unsupported local image URL scheme: %s", parsedURL.Scheme)
	}

	if runtime.GOOS == "windows" && parsedURL.Host != "" {
		return `\\` + parsedURL.Host + filepath.FromSlash(parsedURL.Path), nil
	}

	localPath := filepath.FromSlash(parsedURL.Path)
	if runtime.GOOS == "windows" && strings.HasPrefix(localPath, `\`) && len(localPath) >= 3 && localPath[2] == ':' {
		localPath = localPath[1:]
	}

	return localPath, nil
}

func isWindowsAbsolutePath(path string) bool {
	if strings.HasPrefix(path, `\\`) {
		return true
	}

	if len(path) < 3 {
		return false
	}

	driveLetter := path[0]
	return ((driveLetter >= 'A' && driveLetter <= 'Z') || (driveLetter >= 'a' && driveLetter <= 'z')) &&
		path[1] == ':' &&
		(path[2] == '\\' || path[2] == '/')
}
