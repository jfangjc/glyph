package main

import (
	"embed"
	"log"

	"glyph/internal/documents"
	"glyph/internal/launch"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// Wails uses Go's `embed` package to embed the frontend files into the binary.
// Any files in the frontend/dist folder will be embedded into the binary and
// made available to the frontend.
// See https://pkg.go.dev/embed for more information.

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	launchService := launch.NewService()

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

	app.Window.NewWithOptions(application.WebviewWindowOptions{
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
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
