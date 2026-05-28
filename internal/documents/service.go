package documents

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
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

func (*Service) ReadSiblingPdfPreview(sourcePath string) (*PdfPreviewFile, error) {
	resolvedSourcePath, err := resolveFilePath(sourcePath)
	if err != nil {
		return nil, err
	}

	sourceExtension := filepath.Ext(resolvedSourcePath)
	pdfPath := strings.TrimSuffix(resolvedSourcePath, sourceExtension) + ".pdf"
	content, err := readOrCompilePdfPreview(resolvedSourcePath, pdfPath)
	if err != nil {
		return nil, err
	}

	const mimeType = "application/pdf"
	return &PdfPreviewFile{
		Path:     pdfPath,
		MimeType: mimeType,
		DataURL:  "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(content),
	}, nil
}

func readOrCompilePdfPreview(sourcePath string, pdfPath string) ([]byte, error) {
	content, err := os.ReadFile(pdfPath)
	if err == nil {
		return content, nil
	}

	if !os.IsNotExist(err) {
		return nil, err
	}

	if err := compileTexToPdf(sourcePath); err != nil {
		return nil, err
	}

	return os.ReadFile(pdfPath)
}

func compileTexToPdf(sourcePath string) error {
	command, args, err := resolveTexCompileCommand(sourcePath)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, command, args...)
	cmd.Dir = filepath.Dir(sourcePath)

	output, err := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return fmt.Errorf("TeX compile timed out")
	}

	if err != nil {
		return fmt.Errorf("TeX compile failed: %w: %s", err, strings.TrimSpace(string(output)))
	}

	return nil
}

func resolveTexCompileCommand(sourcePath string) (string, []string, error) {
	sourceFileName := filepath.Base(sourcePath)
	commands := []struct {
		name string
		args []string
	}{
		{
			name: "latexmk",
			args: []string{"-pdf", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", sourceFileName},
		},
		{
			name: "tectonic",
			args: []string{"--keep-logs", "--keep-intermediates", sourceFileName},
		},
		{
			name: "pdflatex",
			args: []string{"-interaction=nonstopmode", "-halt-on-error", "-file-line-error", sourceFileName},
		},
		{
			name: "xelatex",
			args: []string{"-interaction=nonstopmode", "-halt-on-error", "-file-line-error", sourceFileName},
		},
		{
			name: "lualatex",
			args: []string{"-interaction=nonstopmode", "-halt-on-error", "-file-line-error", sourceFileName},
		},
	}

	for _, command := range commands {
		path, err := exec.LookPath(command.name)
		if err == nil {
			return path, command.args, nil
		}
	}

	return "", nil, fmt.Errorf("no TeX compiler found")
}

func (*Service) CreateUntitledMarkdownDocument(baseFilePath string) (*DocumentFile, error) {
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

func (*Service) ReadDirectoryTree(path string) (*DirectoryTree, error) {
	resolvedPath, err := resolveFilePath(path)
	if err != nil {
		return nil, err
	}

	info, err := os.Stat(resolvedPath)
	if err != nil {
		return nil, err
	}

	if !info.IsDir() {
		return nil, &os.PathError{Op: "read directory", Path: resolvedPath, Err: os.ErrInvalid}
	}

	children, err := readDirectoryChildren(resolvedPath, 0)
	if err != nil {
		return nil, err
	}

	return &DirectoryTree{
		Path:     resolvedPath,
		Name:     filepath.Base(resolvedPath),
		Children: children,
	}, nil
}

func readDirectoryChildren(path string, depth int) ([]*DirectoryTreeItem, error) {
	if depth >= 8 {
		return nil, nil
	}

	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, err
	}

	items := make([]*DirectoryTreeItem, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if shouldHideDirectoryEntry(name, entry.IsDir()) {
			continue
		}

		childPath := filepath.Join(path, name)
		item := &DirectoryTreeItem{
			Path:  childPath,
			Name:  name,
			IsDir: entry.IsDir(),
		}

		if entry.IsDir() {
			children, err := readDirectoryChildren(childPath, depth+1)
			if err != nil {
				continue
			}
			item.Children = children
		}

		items = append(items, item)
	}

	sort.SliceStable(items, func(i, j int) bool {
		if items[i].IsDir != items[j].IsDir {
			return items[i].IsDir
		}

		return strings.ToLower(items[i].Name) < strings.ToLower(items[j].Name)
	})

	return items, nil
}

func shouldHideDirectoryEntry(name string, isDir bool) bool {
	if strings.HasPrefix(name, ".") {
		return true
	}

	if !isDir {
		return false
	}

	switch strings.ToLower(name) {
	case "node_modules", "dist", "build", "bin":
		return true
	default:
		return false
	}
}
