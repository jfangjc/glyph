package documents

import (
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
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

	// Replace the bytes only after a complete write, so an interrupted or
	// failed save cannot truncate the user's current document.
	// New files keep CreateTemp's private mode; existing files retain theirs.
	mode := os.FileMode(0o600)
	if info, statErr := os.Stat(resolvedPath); statErr == nil {
		if !info.Mode().IsRegular() {
			return &os.PathError{Op: "save", Path: resolvedPath, Err: os.ErrInvalid}
		}
		mode = info.Mode().Perm()
		if mode&0o222 == 0 {
			return &os.PathError{Op: "save", Path: resolvedPath, Err: os.ErrPermission}
		}
		// Follow an existing symlink, rather than replacing the link itself.
		resolvedPath, err = filepath.EvalSymlinks(resolvedPath)
		if err != nil {
			return err
		}
	} else if !os.IsNotExist(statErr) {
		return statErr
	} else if _, linkErr := os.Lstat(resolvedPath); linkErr == nil {
		// A dangling symlink must not be silently replaced with a new file.
		return statErr
	}

	file, err := os.CreateTemp(filepath.Dir(resolvedPath), ".glyph-save-*")
	if err != nil {
		return err
	}
	tempPath := file.Name()
	defer os.Remove(tempPath)
	defer file.Close()
	if _, err = file.WriteString(content); err != nil {
		return err
	}
	if err = file.Chmod(mode); err != nil {
		return err
	}
	if err = file.Sync(); err != nil {
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	return os.Rename(tempPath, resolvedPath)
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

	if target, err := os.Lstat(resolvedNewPath); err == nil {
		// On Windows a casing change resolves to the existing source file.
		source, sourceErr := os.Lstat(resolvedOldPath)
		if runtime.GOOS != "windows" || !strings.EqualFold(resolvedOldPath, resolvedNewPath) ||
			sourceErr != nil || !os.SameFile(source, target) {
			return os.ErrExist
		}
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
