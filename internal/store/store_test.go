package store

import (
	"errors"
	"fmt"
	"io/fs"
	"testing"
)

func putPages(t *testing.T, s *Store, first, last uint64, tag string) {
	t.Helper()
	for id := first; id <= last; id++ {
		if err := s.Put(id, []byte(fmt.Sprintf("value-%d-%s", id, tag))); err != nil {
			t.Fatalf("Put(%d): %v", id, err)
		}
	}
}

func wantPages(t *testing.T, s *Store, first, last uint64, tag string) {
	t.Helper()
	for id := first; id <= last; id++ {
		got, err := s.Get(id)
		if err != nil {
			t.Fatalf("Get(%d): %v", id, err)
		}
		want := fmt.Sprintf("value-%d-%s", id, tag)
		if string(got) != want {
			t.Fatalf("Get(%d) = %q, want %q", id, got, want)
		}
	}
}

func TestPutGetRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	putPages(t, s, 1, 10, "a")
	wantPages(t, s, 1, 10, "a")
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestOverwriteKeepsLatest(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	putPages(t, s, 1, 5, "old")
	putPages(t, s, 1, 5, "new")
	wantPages(t, s, 1, 5, "new")
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestPersistenceAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	putPages(t, s, 1, 20, "persist")
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	wantPages(t, s, 1, 20, "persist")
}

func TestGetMissingPage(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.Get(42); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("Get(42) err = %v, want fs.ErrNotExist", err)
	}
}

// External references are stable page IDs: they must resolve to the same
// logical content before and after relocation, across generations.
func TestStableIDResolutionAcrossGenerations(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	putPages(t, s, 1, 30, "gen0")
	gen0 := s.Generation()
	if err := s.Compact(); err != nil {
		t.Fatal(err)
	}
	if s.Generation() != gen0+1 {
		t.Fatalf("generation = %d, want %d", s.Generation(), gen0+1)
	}
	wantPages(t, s, 1, 30, "gen0")
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	// Reopen and compact again: IDs still resolve to the same content.
	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	wantPages(t, s, 1, 30, "gen0")
	putPages(t, s, 31, 40, "gen1")
	if err := s.Compact(); err != nil {
		t.Fatal(err)
	}
	wantPages(t, s, 1, 30, "gen0")
	wantPages(t, s, 31, 40, "gen1")
}
