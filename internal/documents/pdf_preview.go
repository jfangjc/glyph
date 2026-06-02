package documents

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func readSiblingPdfPreview(sourcePath string) (*PdfPreviewFile, error) {
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
