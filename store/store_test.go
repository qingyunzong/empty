package store

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func open(t *testing.T, dir string, opts *Options) *Store {
	t.Helper()
	s, err := Open(dir, opts)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return s
}

func mustPut(t *testing.T, s *Store, id uint64, payload string) {
	t.Helper()
	if err := s.Put(id, []byte(payload)); err != nil {
		t.Fatalf("Put(%d): %v", id, err)
	}
}

func mustGet(t *testing.T, s *Store, id uint64, want string) {
	t.Helper()
	got, err := s.Get(id)
	if err != nil {
		t.Fatalf("Get(%d): %v", id, err)
	}
	if string(got) != want {
		t.Fatalf("Get(%d) = %q, want %q", id, got, want)
	}
}

func TestPutGetDeleteReopen(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir, nil)
	mustPut(t, s, 1, "alpha")
	mustPut(t, s, 2, "beta")
	mustPut(t, s, 1, "alpha-v2") // overwrite via stable page ID
	mustGet(t, s, 1, "alpha-v2")
	if err := s.Delete(2); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := s.Get(2); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after Delete: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	s = open(t, dir, nil)
	defer s.Close()
	mustGet(t, s, 1, "alpha-v2")
	if ids := s.List(); len(ids) != 1 || ids[0] != 1 {
		t.Fatalf("List = %v, want [1]", ids)
	}
	if err := s.Verify(); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}

func TestGetDeleteNotFound(t *testing.T) {
	s := open(t, t.TempDir(), nil)
	defer s.Close()
	if _, err := s.Get(99); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get: %v", err)
	}
	if err := s.Delete(99); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Delete: %v", err)
	}
}

func TestSegmentRotation(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir, &Options{MaxSegmentBytes: 64})
	defer s.Close()
	for i := uint64(1); i <= 6; i++ {
		mustPut(t, s, i, strings.Repeat("x", 40))
	}
	if got := len(s.sortedSegments()); got < 2 {
		t.Fatalf("expected segment rotation, got %d segment(s)", got)
	}
	for i := uint64(1); i <= 6; i++ {
		mustGet(t, s, i, strings.Repeat("x", 40))
	}
	if err := s.Verify(); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}

func TestVerifyDetectsCorruption(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir, nil)
	mustPut(t, s, 7, "integrity-payload")
	gen := s.Generation()
	s.Close()

	// Corrupt one payload byte of the only record (header is 20 bytes).
	path := segmentPath(dir, 1)
	buf, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	buf[recordHeaderSize] ^= 0xFF
	if err := os.WriteFile(path, buf, 0o644); err != nil {
		t.Fatal(err)
	}

	s = open(t, dir, nil)
	defer s.Close()
	if s.Generation() != gen {
		t.Fatalf("generation changed across reopen: %d -> %d", gen, s.Generation())
	}
	if _, err := s.Get(7); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("Get on corrupted page: %v", err)
	}
	if err := s.Verify(); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("Verify on corrupted segment: %v", err)
	}
}

func TestCompactReclaimsGarbage(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir, &Options{MaxSegmentBytes: 128})
	for i := uint64(1); i <= 8; i++ {
		mustPut(t, s, i, strings.Repeat(string(rune('a'+i)), 50))
	}
	// Create garbage: delete half, overwrite the rest.
	for i := uint64(1); i <= 4; i++ {
		if err := s.Delete(i); err != nil {
			t.Fatalf("Delete(%d): %v", i, err)
		}
	}
	for i := uint64(5); i <= 8; i++ {
		mustPut(t, s, i, strings.Repeat(string(rune('A'+i)), 50))
	}
	oldSegments := s.sortedSegments()
	var oldBytes uint64
	for _, id := range oldSegments {
		oldBytes += s.segmentSize(id)
	}

	stats, err := s.Compact()
	if err != nil {
		t.Fatalf("Compact: %v", err)
	}
	if stats.PagesMoved != 4 {
		t.Fatalf("PagesMoved = %d, want 4", stats.PagesMoved)
	}
	if stats.SegmentsRetired != len(oldSegments) {
		t.Fatalf("SegmentsRetired = %d, want %d", stats.SegmentsRetired, len(oldSegments))
	}
	if stats.BytesReclaimed != oldBytes {
		t.Fatalf("BytesReclaimed = %d, want %d (sum of retired segment sizes)", stats.BytesReclaimed, oldBytes)
	}
	// Reclamation range: every retired segment file is gone, and every live
	// reference points into the single compact segment.
	for _, id := range oldSegments {
		if _, err := os.Stat(segmentPath(dir, id)); !os.IsNotExist(err) {
			t.Fatalf("retired segment %d still present", id)
		}
	}
	live := s.sortedSegments()
	if len(live) != 1 {
		t.Fatalf("live segments = %v, want exactly 1", live)
	}
	for _, id := range s.List() {
		if s.index[id].Segment != live[0] {
			t.Fatalf("page %d references segment %d, want compact segment %d", id, s.index[id].Segment, live[0])
		}
	}
	for i := uint64(5); i <= 8; i++ {
		mustGet(t, s, i, strings.Repeat(string(rune('A'+i)), 50))
	}
	if err := s.Verify(); err != nil {
		t.Fatalf("Verify after compact: %v", err)
	}
	s.Close()

	// The compacted state survives reopen.
	s = open(t, dir, nil)
	defer s.Close()
	for i := uint64(5); i <= 8; i++ {
		mustGet(t, s, i, strings.Repeat(string(rune('A'+i)), 50))
	}
	if err := s.Verify(); err != nil {
		t.Fatalf("Verify after reopen: %v", err)
	}
}

func TestCompactEmptyStore(t *testing.T) {
	s := open(t, t.TempDir(), nil)
	defer s.Close()
	stats, err := s.Compact()
	if err != nil {
		t.Fatalf("Compact: %v", err)
	}
	if stats != (Stats{}) {
		t.Fatalf("stats = %+v, want zero", stats)
	}
}

func TestOrphanCleanupOnOpen(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir, nil)
	mustPut(t, s, 1, "live")
	s.Close()

	// Plant crash leftovers: orphan segment, stale index, tmp file.
	if err := os.WriteFile(segmentPath(dir, 77), []byte("orphan"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(indexPath(dir, 999), []byte("stale"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json.tmp"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}

	s = open(t, dir, nil)
	defer s.Close()
	mustGet(t, s, 1, "live")
	for _, name := range []string{segmentPath(dir, 77), indexPath(dir, 999), filepath.Join(dir, "manifest.json.tmp")} {
		if _, err := os.Stat(name); !os.IsNotExist(err) {
			t.Fatalf("leftover %s not reclaimed", name)
		}
	}
}
