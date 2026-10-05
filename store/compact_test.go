package store

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
)

// errCrash simulates a power loss injected at a compaction boundary.
var errCrash = errors.New("simulated power loss")

// buildFragmentedStore returns a store with several segments, 6 live pages
// (1..6) and some garbage, plus the expected live payloads.
func buildFragmentedStore(t *testing.T, dir string) *Store {
	t.Helper()
	s := open(t, dir, &Options{MaxSegmentBytes: 96})
	for i := uint64(1); i <= 6; i++ {
		mustPut(t, s, i, fmt.Sprintf("page-%d-%s", i, strings.Repeat("v", 30)))
	}
	for i := uint64(1); i <= 3; i++ { // garbage for the compactor to drop
		mustPut(t, s, i, "stale-"+strings.Repeat("w", 30))
	}
	return s
}

func wantPayload(id uint64) string {
	if id <= 3 {
		return "stale-" + strings.Repeat("w", 30)
	}
	return fmt.Sprintf("page-%d-%s", id, strings.Repeat("v", 30))
}

// compactWithCrash runs Compact and converts the injected crash panic into
// errCrash, mimicking an abrupt power loss mid-operation.
func compactWithCrash(s *Store) (stats Stats, err error) {
	defer func() {
		if r := recover(); r != nil {
			if r == errCrash {
				err = errCrash
			} else {
				panic(r)
			}
		}
	}()
	return s.Compact()
}

// assertStoreIntact verifies the post-crash invariant: the store opens, the
// committed generation is either the old or the new one, every live page
// resolves through its stable ID with intact content, and all checksums and
// index locations verify.
func assertStoreIntact(t *testing.T, dir string, oldGen uint64) *Store {
	t.Helper()
	s := open(t, dir, nil)
	t.Cleanup(func() { s.Close() })
	if s.Generation() != oldGen && s.Generation() != oldGen+1 {
		t.Fatalf("generation = %d, want %d (old) or %d (new)", s.Generation(), oldGen, oldGen+1)
	}
	for id := uint64(1); id <= 6; id++ {
		mustGet(t, s, id, wantPayload(id))
	}
	if err := s.Verify(); err != nil {
		t.Fatalf("Verify after crash recovery: %v", err)
	}
	return s
}

func dirFileNames(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

// Crash after the copy boundary: the new segment exists but no index or
// manifest references it, so the old generation must be fully intact and the
// orphan must be reclaimed on open.
func TestCrashAfterCopy(t *testing.T) {
	dir := t.TempDir()
	s := buildFragmentedStore(t, dir)
	oldGen := s.Generation()
	s.hooks.AfterCopy = func() { panic(errCrash) }

	if _, err := compactWithCrash(s); !errors.Is(err, errCrash) {
		t.Fatalf("Compact err = %v, want injected crash", err)
	}

	s = assertStoreIntact(t, dir, oldGen)
	if s.Generation() != oldGen {
		t.Fatalf("generation = %d, want old generation %d (crash before commit)", s.Generation(), oldGen)
	}
	for _, name := range dirFileNames(t, dir) {
		if strings.HasSuffix(name, ".tmp") {
			t.Fatalf("tmp file survived recovery: %s", name)
		}
	}
	// Only the segments of the old generation may remain.
	if got := len(s.sortedSegments()); got == 0 {
		t.Fatal("old generation segments missing after recovery")
	}
	for _, seg := range s.sortedSegments() {
		if _, err := os.Stat(segmentPath(dir, seg)); err != nil {
			t.Fatalf("committed segment %d missing: %v", seg, err)
		}
	}
}

// Crash after the index flush boundary: the new index is durable but the
// manifest still names the old generation, so the old references must be
// fully intact and the flushed-but-uncommitted index must be reclaimed.
func TestCrashAfterIndexFlush(t *testing.T) {
	dir := t.TempDir()
	s := buildFragmentedStore(t, dir)
	oldGen := s.Generation()
	s.hooks.AfterIndexFlush = func() { panic(errCrash) }

	if _, err := compactWithCrash(s); !errors.Is(err, errCrash) {
		t.Fatalf("Compact err = %v, want injected crash", err)
	}

	s = assertStoreIntact(t, dir, oldGen)
	if s.Generation() != oldGen {
		t.Fatalf("generation = %d, want old generation %d (manifest never committed)", s.Generation(), oldGen)
	}
	if _, err := os.Stat(indexPath(dir, oldGen+1)); !os.IsNotExist(err) {
		t.Fatalf("uncommitted index gen %d survived recovery", oldGen+1)
	}
	if _, err := os.Stat(indexPath(dir, oldGen)); err != nil {
		t.Fatalf("committed index gen %d missing: %v", oldGen, err)
	}
}

// Crash at the retirement boundary: the manifest already committed the new
// generation, so the new references must be fully intact and the not-yet-
// retired old segments must be reclaimed on open.
func TestCrashBeforeRetire(t *testing.T) {
	dir := t.TempDir()
	s := buildFragmentedStore(t, dir)
	oldGen := s.Generation()
	s.hooks.BeforeRetire = func() { panic(errCrash) }

	if _, err := compactWithCrash(s); !errors.Is(err, errCrash) {
		t.Fatalf("Compact err = %v, want injected crash", err)
	}

	s = assertStoreIntact(t, dir, oldGen)
	if s.Generation() != oldGen+1 {
		t.Fatalf("generation = %d, want new generation %d (commit already happened)", s.Generation(), oldGen+1)
	}
	live := s.sortedSegments()
	if len(live) != 1 {
		t.Fatalf("live segments after recovery = %v, want exactly the compact segment", live)
	}
	// Every live reference must point into the compact segment.
	for _, id := range s.List() {
		if s.index[id].Segment != live[0] {
			t.Fatalf("page %d references segment %d, want %d", id, s.index[id].Segment, live[0])
		}
	}
}

// Crash midway through retirement: some old segments are already deleted,
// the rest linger as orphans. Recovery must keep the new generation intact
// and reclaim the remaining orphans.
func TestCrashDuringRetire(t *testing.T) {
	dir := t.TempDir()
	retired := 0
	s := buildFragmentedStore(t, dir)
	oldGen := s.Generation()
	s.hooks.AfterRetireSegment = func(uint64) {
		retired++
		if retired == 1 {
			panic(errCrash) // power loss after the first segment is retired
		}
	}
	oldSegments := s.sortedSegments()
	if len(oldSegments) < 2 {
		t.Fatalf("test needs >=2 old segments, got %d", len(oldSegments))
	}

	if _, err := compactWithCrash(s); !errors.Is(err, errCrash) {
		t.Fatalf("Compact err = %v, want injected crash", err)
	}

	s = assertStoreIntact(t, dir, oldGen)
	if s.Generation() != oldGen+1 {
		t.Fatalf("generation = %d, want new generation %d", s.Generation(), oldGen+1)
	}
	for _, seg := range oldSegments {
		if _, err := os.Stat(segmentPath(dir, seg)); !os.IsNotExist(err) {
			t.Fatalf("orphan segment %d not reclaimed during recovery", seg)
		}
	}
}

// A compacted store accepts new writes that land in the compact segment.
func TestPutAfterCompact(t *testing.T) {
	dir := t.TempDir()
	s := buildFragmentedStore(t, dir)
	if _, err := s.Compact(); err != nil {
		t.Fatalf("Compact: %v", err)
	}
	mustPut(t, s, 7, "post-compact")
	mustGet(t, s, 7, "post-compact")
	for id := uint64(1); id <= 6; id++ {
		mustGet(t, s, id, wantPayload(id))
	}
	if err := s.Verify(); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	s.Close()
	s = open(t, dir, nil)
	defer s.Close()
	mustGet(t, s, 7, "post-compact")
}
