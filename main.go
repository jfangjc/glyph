package main

import (
	"embed"
	"log"
	"sync/atomic"

	"glyph/internal/documents"
	"glyph/internal/launch"
	"glyph/internal/windowstate"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// Wails uses Go's `embed` package to embed the frontend files into the binary.
// Any files in the frontend/dist folder will be embedded into the binary and
// made available to the frontend.
// See https://pkg.go.dev/embed for more information.

//go:embed all:frontend/dist
var assets embed.FS

const (
	windowCloseRequestedEvent = "glyph:window-close-requested"
	windowCloseConfirmedEvent = "glyph:window-close-confirmed"
)

func main() {
	launchService := launch.NewService()
	windowStateStore := windowstate.New("Glyph")
	savedWindowState := windowStateStore.Load()
	var allowWindowClose atomic.Bool
	var windowCloseGuardReady atomic.Bool

	app := application.New(application.Options{
		Name:        "Glyph",
		Description: "A lightweight, minimalistic cross-platform document editor.",
		Services: []application.Service{
			application.NewService(&documents.Service{}),
			application.NewService(launchService),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		FileAssociations: launch.FileAssociations(),
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: "app.glyph.editor",
			ExitCode: 0,
			OnSecondInstanceLaunch: func(data application.SecondInstanceData) {
				launch.QueueSecondInstanceLaunch(launchService, data)
			},
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})
	launch.BindApp(launchService, app)
	launch.QueueCurrentProcessArgs(launchService)
	app.Event.OnApplicationEvent(events.Common.ApplicationOpenedWithFile, func(event *application.ApplicationEvent) {
		launch.QueueOpenDocumentPath(launchService, event.Context().Filename(), "")
	})

	windowOptions := application.WebviewWindowOptions{
		Title:     "Glyph",
		Width:     1180,
		Height:    760,
		MinWidth:  820,
		MinHeight: 560,
		Frameless: true,
		Mac: application.MacWindow{
			InvisibleTitleBarHeight: 50,
			TitleBar:                application.MacTitleBarHiddenInset,
		},
		BackgroundColour: application.NewRGB(250, 250, 248),
		URL:              "/",
	}
	windowstate.ApplyToOptions(&windowOptions, savedWindowState)

	mainWindow := app.Window.NewWithOptions(windowOptions)
	mainWindow.OnWindowEvent(events.Common.WindowRuntimeReady, func(_ *application.WindowEvent) {
		windowCloseGuardReady.Store(true)
	})
	mainWindow.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
		if !windowCloseGuardReady.Load() || allowWindowClose.Load() {
			return
		}

		event.Cancel()
		mainWindow.EmitEvent(windowCloseRequestedEvent)
	})
	app.Event.On(windowCloseConfirmedEvent, func(_ *application.CustomEvent) {
		if allowWindowClose.Swap(true) {
			return
		}

		mainWindow.Close()
	})
	windowStateStore.Track(mainWindow, savedWindowState.Maximized)

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
