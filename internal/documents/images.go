package documents

import (
	"encoding/base64"
	"fmt"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func (*Service) ReadImage(path string, baseFilePath string) (*ImageFile, error) {
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
