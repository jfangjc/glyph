package launch

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
)

const OpenDocumentRequestedEvent = "glyph:open-document-requested"

type formatCatalog struct {
	Formats []struct {
		ID               string   `json:"id"`
		Label            string   `json:"label"`
		Extensions       []string `json:"extensions"`
		DefaultExtension string   `json:"defaultExtension"`
		DefaultFileName  string   `json:"defaultFileName"`
		Adapter          string   `json:"adapter"`
	} `json:"formats"`
}

func init() {
	application.RegisterEvent[string](OpenDocumentRequestedEvent)
}

type Service struct {
	app                         *application.App
	mu                          sync.Mutex
	supportedDocumentExtensions []string

	pendingOpenDocumentPaths []string
}

func NewService(supportedDocumentExtensions []string) *Service {
	return &Service{supportedDocumentExtensions: append([]string(nil), supportedDocumentExtensions...)}
}

func ParseFileAssociations(data []byte) ([]string, error) {
	var catalog formatCatalog
	if err := json.Unmarshal(data, &catalog); err != nil {
		return nil, fmt.Errorf("parse format catalog: %w", err)
	}
	if len(catalog.Formats) == 0 {
		return nil, fmt.Errorf("format catalog contains no formats")
	}

	ids := make(map[string]struct{}, len(catalog.Formats))
	extensions := make(map[string]struct{})
	associations := make([]string, 0)
	for _, format := range catalog.Formats {
		format.ID = strings.TrimSpace(format.ID)
		if format.ID == "" {
			return nil, fmt.Errorf("format catalog contains an empty id")
		}
		if strings.TrimSpace(format.Label) == "" || strings.TrimSpace(format.DefaultFileName) == "" {
			return nil, fmt.Errorf("format %q is missing its label or default file name", format.ID)
		}
		if format.Adapter != "" && format.Adapter != "markdown" && format.Adapter != "latex" {
			return nil, fmt.Errorf("unknown format adapter %q for format %q", format.Adapter, format.ID)
		}
		if _, exists := ids[format.ID]; exists {
			return nil, fmt.Errorf("duplicate format id %q", format.ID)
		}
		ids[format.ID] = struct{}{}

		defaultExtension := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(format.DefaultExtension), "."))
		defaultFound := false
		for _, extension := range format.Extensions {
			extension = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(extension), "."))
			if extension == "" {
				return nil, fmt.Errorf("format %q contains an empty extension", format.ID)
			}
			if _, exists := extensions[extension]; exists {
				return nil, fmt.Errorf("duplicate format extension %q", extension)
			}
			extensions[extension] = struct{}{}
			associations = append(associations, "."+extension)
			defaultFound = defaultFound || extension == defaultExtension
		}
		if !defaultFound {
			return nil, fmt.Errorf("default extension %q is not registered for format %q", format.DefaultExtension, format.ID)
		}
	}

	return associations, nil
}

func BindApp(service *Service, app *application.App) {
	service.bindApp(app)
}

func QueueCurrentProcessArgs(service *Service) {
	service.queueCurrentProcessArgs()
}

func QueueSecondInstanceLaunch(service *Service, data application.SecondInstanceData) {
	service.queueSecondInstanceLaunch(data)
}

func QueueOpenDocumentPath(service *Service, path string, workingDir string) {
	service.queueOpenDocumentPath(path, workingDir)
}

func (s *Service) bindApp(app *application.App) {
	s.app = app
}

func (s *Service) queueCurrentProcessArgs() {
	s.queueArgs(os.Args, currentWorkingDir())
}

func (s *Service) queueSecondInstanceLaunch(data application.SecondInstanceData) {
	s.queueArgs(data.Args, data.WorkingDir)
	s.showExistingWindows()
}

func (s *Service) queueArgs(args []string, workingDir string) {
	for _, arg := range args[1:] {
		s.queueOpenDocumentPath(arg, workingDir)
	}
}

func (s *Service) queueOpenDocumentPath(path string, workingDir string) {
	resolvedPath, ok := s.resolveDocumentPath(path, workingDir)
	if !ok {
		return
	}

	s.mu.Lock()
	if hasPendingPath(s.pendingOpenDocumentPaths, resolvedPath) {
		s.mu.Unlock()
		return
	}
	s.pendingOpenDocumentPaths = append(s.pendingOpenDocumentPaths, resolvedPath)
	s.mu.Unlock()

	if s.app != nil {
		s.app.Event.Emit(OpenDocumentRequestedEvent, resolvedPath)
	}
}

func (s *Service) TakePendingOpenDocumentPaths() []string {
	s.mu.Lock()
	defer s.mu.Unlock()

	paths := append([]string(nil), s.pendingOpenDocumentPaths...)
	s.pendingOpenDocumentPaths = nil
	return paths
}

func FileAssociations(supportedDocumentExtensions []string) []string {
	return append([]string(nil), supportedDocumentExtensions...)
}

func (s *Service) resolveDocumentPath(path string, workingDir string) (string, bool) {
	trimmedPath := strings.TrimSpace(path)
	if trimmedPath == "" || strings.Contains(trimmedPath, "://") {
		return "", false
	}

	if !s.isSupportedDocumentExtension(filepath.Ext(trimmedPath)) {
		return "", false
	}

	resolvedPath := trimmedPath
	if !filepath.IsAbs(resolvedPath) && workingDir != "" {
		resolvedPath = filepath.Join(workingDir, resolvedPath)
	}

	absolutePath, err := filepath.Abs(resolvedPath)
	if err != nil {
		return "", false
	}

	return absolutePath, true
}

func (s *Service) isSupportedDocumentExtension(extension string) bool {
	extension = strings.ToLower(extension)
	for _, supportedExtension := range s.supportedDocumentExtensions {
		if extension == supportedExtension {
			return true
		}
	}

	return false
}

func hasPendingPath(paths []string, path string) bool {
	comparablePath := comparableFilePath(path)
	for _, pendingPath := range paths {
		if comparableFilePath(pendingPath) == comparablePath {
			return true
		}
	}

	return false
}

func comparableFilePath(path string) string {
	cleanPath := filepath.Clean(path)
	if runtime.GOOS == "windows" {
		return strings.ToLower(cleanPath)
	}

	return cleanPath
}

func currentWorkingDir() string {
	dir, err := os.Getwd()
	if err != nil {
		return ""
	}

	return dir
}

func (s *Service) showExistingWindows() {
	if s.app == nil {
		return
	}

	for _, window := range s.app.Window.GetAll() {
		window.Show()
		window.Focus()
	}
}
