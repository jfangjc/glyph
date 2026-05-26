package documents

import (
	"encoding/base64"
	"fmt"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
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

func (*Service) SavePastedImage(baseFilePath string, dataURL string, originalName string, mimeType string) (*PastedImageFile, error) {
	resolvedBasePath, err := resolveFilePath(baseFilePath)
	if err != nil {
		return nil, err
	}

	mediaType, data, err := decodeImageDataURL(dataURL)
	if err != nil {
		return nil, err
	}

	if mimeType == "" {
		mimeType = mediaType
	}

	if !strings.HasPrefix(strings.ToLower(mimeType), "image/") {
		return nil, fmt.Errorf("clipboard content is not an image")
	}

	assetsDir := filepath.Join(filepath.Dir(resolvedBasePath), ".assets")
	if err := os.MkdirAll(assetsDir, 0o755); err != nil {
		return nil, err
	}

	fileName := uniquePastedImageFileName(assetsDir, originalName, mimeType)
	path := filepath.Join(assetsDir, fileName)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return nil, err
	}

	return &PastedImageFile{
		Path:         path,
		RelativePath: filepath.ToSlash(filepath.Join(".assets", fileName)),
	}, nil
}

func decodeImageDataURL(dataURL string) (string, []byte, error) {
	const marker = ";base64,"
	if !strings.HasPrefix(dataURL, "data:") {
		return "", nil, fmt.Errorf("image data URL is required")
	}

	markerIndex := strings.Index(dataURL, marker)
	if markerIndex < 0 {
		return "", nil, fmt.Errorf("image data URL must be base64 encoded")
	}

	mediaType := dataURL[len("data:"):markerIndex]
	if !strings.HasPrefix(strings.ToLower(mediaType), "image/") {
		return "", nil, fmt.Errorf("data URL is not an image")
	}

	data, err := base64.StdEncoding.DecodeString(dataURL[markerIndex+len(marker):])
	if err != nil {
		return "", nil, err
	}

	return mediaType, data, nil
}

func uniquePastedImageFileName(dir string, originalName string, mimeType string) string {
	extension := strings.ToLower(filepath.Ext(originalName))
	if extension == "" || len(extension) > 10 {
		extension = extensionForImageMimeType(mimeType)
	}

	base := sanitizeImageFileName(strings.TrimSuffix(filepath.Base(originalName), filepath.Ext(originalName)))
	if base == "" {
		base = "image"
	}

	stamp := time.Now().Format("20060102-150405")
	for index := 0; ; index++ {
		suffix := stamp
		if index > 0 {
			suffix = fmt.Sprintf("%s-%d", stamp, index+1)
		}

		fileName := fmt.Sprintf("%s-%s%s", base, suffix, extension)
		if _, err := os.Stat(filepath.Join(dir, fileName)); os.IsNotExist(err) {
			return fileName
		}
	}
}

func extensionForImageMimeType(mimeType string) string {
	switch strings.ToLower(mimeType) {
	case "image/jpeg", "image/jpg":
		return ".jpg"
	case "image/png":
		return ".png"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	case "image/svg+xml":
		return ".svg"
	case "image/bmp":
		return ".bmp"
	default:
		return ".png"
	}
}

func sanitizeImageFileName(value string) string {
	sanitized := regexp.MustCompile(`[^A-Za-z0-9._-]+`).ReplaceAllString(value, "-")
	sanitized = strings.Trim(sanitized, ".-_")
	if len(sanitized) > 48 {
		sanitized = sanitized[:48]
	}
	return sanitized
}
