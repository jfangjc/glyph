package launch

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
)

const OpenDocumentRequestedEvent = "glyph:open-document-requested"

var supportedDocumentExtensions = []string{".md", ".markdown", ".tex", ".org", ".typ", ".txt", ".text"}

func init() {
	application.RegisterEvent[string](OpenDocumentRequestedEvent)
}

type Service struct {
	app *application.App
	mu  sync.Mutex

	pendingOpenDocumentPaths []string
}

func NewService() *Service {
	return &Service{}
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
	resolvedPath, ok := resolveDocumentPath(path, workingDir)
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

func FileAssociations() []string {
	return append([]string(nil), supportedDocumentExtensions...)
}

func resolveDocumentPath(path string, workingDir string) (string, bool) {
	trimmedPath := strings.TrimSpace(path)
	if trimmedPath == "" || strings.Contains(trimmedPath, "://") {
		return "", false
	}

	if !isSupportedDocumentExtension(filepath.Ext(trimmedPath)) {
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

func isSupportedDocumentExtension(extension string) bool {
	extension = strings.ToLower(extension)
	for _, supportedExtension := range supportedDocumentExtensions {
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
