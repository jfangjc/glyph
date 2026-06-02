package windowstate

import (
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

const fileName = "window-state.json"

type State struct {
	X         int  `json:"x"`
	Y         int  `json:"y"`
	Width     int  `json:"width"`
	Height    int  `json:"height"`
	Maximized bool `json:"maximized"`
}

type Store struct {
	path  string
	mu    sync.Mutex
	state State
}

func New(appName string) *Store {
	configDir, err := os.UserConfigDir()
	if err != nil {
		log.Printf("window state: failed to resolve config directory: %v", err)
		return &Store{}
	}

	return &Store{
		path: filepath.Join(configDir, appName, fileName),
	}
}

func (s *Store) Load() State {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.path == "" {
		return State{}
	}

	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return State{}
	}
	if err != nil {
		log.Printf("window state: failed to read %s: %v", s.path, err)
		return State{}
	}

	var state State
	if err := json.Unmarshal(data, &state); err != nil {
		log.Printf("window state: failed to parse %s: %v", s.path, err)
		return State{}
	}

	s.state = state
	return state
}

func ApplyToOptions(options *application.WebviewWindowOptions, state State) {
	if !state.HasBounds() {
		return
	}

	options.Width = max(options.MinWidth, state.Width)
	options.Height = max(options.MinHeight, state.Height)
	options.InitialPosition = application.WindowXY
	options.X = state.X
	options.Y = state.Y
}

func (s State) HasBounds() bool {
	return s.Width > 0 && s.Height > 0
}

func (s *Store) Track(window application.Window, restoreMaximized bool) {
	if restoreMaximized {
		var cancel func()
		cancel = window.OnWindowEvent(events.Common.WindowShow, func(_ *application.WindowEvent) {
			if cancel != nil {
				cancel()
			}
			window.Maximise()
		})
	}

	save := func() {
		if err := s.SaveWindow(window); err != nil {
			log.Printf("window state: failed to save: %v", err)
		}
	}

	window.OnWindowEvent(events.Common.WindowDidMove, func(_ *application.WindowEvent) {
		save()
	})
	window.OnWindowEvent(events.Common.WindowDidResize, func(_ *application.WindowEvent) {
		save()
	})
	window.OnWindowEvent(events.Common.WindowMaximise, func(_ *application.WindowEvent) {
		save()
	})
	window.OnWindowEvent(events.Common.WindowUnMaximise, func(_ *application.WindowEvent) {
		save()
	})
	window.RegisterHook(events.Common.WindowClosing, func(_ *application.WindowEvent) {
		save()
	})
}

func (s *Store) SaveWindow(window application.Window) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.path == "" {
		return nil
	}

	state := s.state
	state.Maximized = window.IsMaximised()

	if isNormalWindow(window) {
		bounds := window.Bounds()
		if bounds.Width > 0 && bounds.Height > 0 {
			state.X = bounds.X
			state.Y = bounds.Y
			state.Width = bounds.Width
			state.Height = bounds.Height
		}
	}

	s.state = state
	return writeStateFile(s.path, state)
}

func isNormalWindow(window application.Window) bool {
	return !window.IsMaximised() && !window.IsMinimised() && !window.IsFullscreen()
}

func writeStateFile(path string, state State) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')

	tempPath := path + ".tmp"
	if err := os.WriteFile(tempPath, data, 0o644); err != nil {
		return err
	}

	return os.Rename(tempPath, path)
}
