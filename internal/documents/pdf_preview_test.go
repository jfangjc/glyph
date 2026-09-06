package documents

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPdfPreviewFreshness(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "sample.tex")
	pdf := filepath.Join(dir, "sample.pdf")
	if err := os.WriteFile(source, []byte("sample"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pdf, []byte("%PDF-1.4\n"), 0600); err != nil {
		t.Fatal(err)
	}
	now := time.Now().Add(-time.Minute)
	if err := os.Chtimes(source, now, now); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		offset time.Duration
		stale  bool
	}{
		{"older PDF", -time.Minute, true}, {"newer PDF", time.Minute, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			when := now.Add(tc.offset)
			if err := os.Chtimes(pdf, when, when); err != nil {
				t.Fatal(err)
			}
			preview, err := readSiblingPdfPreview(source, false)
			if err != nil {
				t.Fatal(err)
			}
			if preview.Stale != tc.stale {
				t.Fatalf("Stale = %v, want %v", preview.Stale, tc.stale)
			}
			if preview.Path != pdf || preview.DataURL == "" {
				t.Fatal("missing preview data")
			}
		})
	}
}
