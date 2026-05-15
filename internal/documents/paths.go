package documents

import (
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"runtime"
	"strings"
)

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
