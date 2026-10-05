package store

import (
	"os"
	"path/filepath"
	"testing"
)

func openSeeded(t *testing.T, dir string) *Store {
	t.Helper()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	putPages(t, s, 1, 10, "audit")
	if err := s.Compact(); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	report, err := Verify(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !report.OK() {
		t.Fatalf("seeded store not clean: %v", report)
	}
	return nil
}

func TestVerifyCleanStore(t *testing.T) {
	dir := t.TempDir()
	openSeeded(t, dir)
	report, err := Verify(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !report.OK() || report.Pages != 10 || report.Generation != 1 {
		t.Fatalf("unexpected report: %v", report)
	}
}

// A single flipped payload byte must be caught by the per-page checksum
// audit.
func TestVerifyDetectsCorruptPage(t *testing.T) {
	dir := t.TempDir()
	openSeeded(t, dir)

	var segPath string
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if _, ok := parseSegFileName(e.Name()); ok {
			segPath = filepath.Join(dir, e.Name())
		}
	}
	f, err := os.OpenFile(segPath, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteAt([]byte{0xFF}, recordHeaderSize+3); err != nil {
		t.Fatal(err)
	}
	f.Close()

	report, err := Verify(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.BadPages) != 1 || report.BadPages[0] != 1 {
		t.Fatalf("BadPages = %v, want [1]", report.BadPages)
	}
	if report.OK() {
		t.Fatal("report should not be OK")
	}
}

// An unreferenced segment file lies outside the reclamation range and
// must be flagged.
func TestVerifyDetectsOrphanSegment(t *testing.T) {
	dir := t.TempDir()
	openSeeded(t, dir)
	if err := os.WriteFile(filepath.Join(dir, segFileName(7777)), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	report, err := Verify(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.OrphanSegments) != 1 || report.OrphanSegments[0] != 7777 {
		t.Fatalf("OrphanSegments = %v, want [7777]", report.OrphanSegments)
	}
}

// A referenced segment gone missing must be flagged, and its pages fail
// the checksum audit.
func TestVerifyDetectsMissingSegment(t *testing.T) {
	dir := t.TempDir()
	openSeeded(t, dir)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if _, ok := parseSegFileName(e.Name()); ok {
			if err := os.Remove(filepath.Join(dir, e.Name())); err != nil {
				t.Fatal(err)
			}
		}
	}
	report, err := Verify(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.MissingSegments) != 1 {
		t.Fatalf("MissingSegments = %v, want 1 entry", report.MissingSegments)
	}
	if len(report.BadPages) != 10 {
		t.Fatalf("BadPages = %v, want 10 entries", report.BadPages)
	}
}

// Leftover temp files and foreign-generation index logs are stray files.
func TestVerifyDetectsStrayFiles(t *testing.T) {
	dir := t.TempDir()
	openSeeded(t, dir)
	for _, name := range []string{indexFileName(55), "COMMIT.tmp"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	report, err := Verify(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.StrayFiles) != 2 {
		t.Fatalf("StrayFiles = %v, want 2 entries", report.StrayFiles)
	}
}
