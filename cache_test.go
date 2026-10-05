package fileindex

import (
	"os"
	"path/filepath"
	"testing"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func findEntry(t *testing.T, entries []Entry, path string) Entry {
	t.Helper()
	for _, e := range entries {
		if e.Path == path {
			return e
		}
	}
	t.Fatalf("no entry for %s in %+v", path, entries)
	return Entry{}
}

// recreate simulates path reuse: the file is deleted and created again
// at the same path, and the cache is notified as a watcher would do.
func recreate(t *testing.T, c *Cache, path, content string) {
	t.Helper()
	if err := os.Remove(path); err != nil {
		t.Fatalf("remove %s: %v", path, err)
	}
	c.Delete(path)
	writeFile(t, path, content)
	c.Create(path)
}

// TestStaleAsyncScanRejectedAfterPathReuse parks an async scan at a
// barrier between baseline capture and publish, deletes and recreates
// a scanned path, and requires the stale result to be rejected. A
// synchronous rescan afterwards must succeed, and the two results are
// compared: the rescan observes the new generation and new content.
func TestStaleAsyncScanRejectedAfterPathReuse(t *testing.T) {
	dir := t.TempDir()
	victim := filepath.Join(dir, "a.txt")
	stable := filepath.Join(dir, "b.txt")
	writeFile(t, victim, "stale-payload")
	writeFile(t, stable, "stable")

	cache := NewCache()
	res, err := cache.Scanner().Scan(dir)
	if err != nil || !res.Published {
		t.Fatalf("initial scan: res=%+v err=%v", res, err)
	}
	oldGen := cache.Generation(victim)

	// Async scan parked at the barrier before publish.
	entered := make(chan struct{})
	release := make(chan struct{})
	scanner := cache.Scanner()
	scanner.BeforePublish = func() {
		close(entered)
		<-release
	}

	type outcome struct {
		res Result
		err error
	}
	done := make(chan outcome, 1)
	go func() {
		res, err := scanner.Scan(dir)
		done <- outcome{res, err}
	}()

	<-entered
	// Path reuse while the scan is parked.
	recreate(t, cache, victim, "fresh")
	close(release)
	out := <-done

	if out.err != nil {
		t.Fatalf("async scan: %v", out.err)
	}
	if out.res.Published {
		t.Fatalf("stale async scan was published: %+v", out.res.Entries)
	}
	staleEntry := findEntry(t, out.res.Entries, victim)
	if staleEntry.Generation != oldGen {
		t.Fatalf("stale entry generation = %d, want %d", staleEntry.Generation, oldGen)
	}
	if staleEntry.Size != int64(len("stale-payload")) {
		t.Fatalf("stale entry size = %d, want %d", staleEntry.Size, len("stale-payload"))
	}

	// Synchronous rescan must succeed and observe the new state.
	syncRes, err := cache.Scanner().Scan(dir)
	if err != nil {
		t.Fatalf("sync rescan: %v", err)
	}
	if !syncRes.Published {
		t.Fatal("sync rescan was rejected")
	}
	freshEntry := findEntry(t, syncRes.Entries, victim)

	// Compare async (rejected) vs sync (published) results.
	if freshEntry.Generation <= staleEntry.Generation {
		t.Fatalf("rescan generation %d not newer than stale %d",
			freshEntry.Generation, staleEntry.Generation)
	}
	if want := oldGen + 2; freshEntry.Generation != want { // Delete + Create
		t.Fatalf("rescan generation = %d, want %d", freshEntry.Generation, want)
	}
	if freshEntry.Size != int64(len("fresh")) {
		t.Fatalf("rescan size = %d, want %d", freshEntry.Size, len("fresh"))
	}

	// The cache holds the fresh entry, not the stale one.
	cached, ok := cache.Entry(victim)
	if !ok {
		t.Fatal("cache has no entry for victim after rescan")
	}
	if cached != freshEntry {
		t.Fatalf("cached entry %+v != rescan entry %+v", cached, freshEntry)
	}
	if cached == staleEntry {
		t.Fatal("cache holds the stale entry")
	}
}

// TestMultiDirPublishRequiresAllBaselinesValid scans two directories
// and mutates a path in only one of them during the barrier; the whole
// publish must be rejected because not all baselines remain valid.
func TestMultiDirPublishRequiresAllBaselinesValid(t *testing.T) {
	dirA := t.TempDir()
	dirB := t.TempDir()
	fileA := filepath.Join(dirA, "a.txt")
	fileB := filepath.Join(dirB, "b.txt")
	writeFile(t, fileA, "a")
	writeFile(t, fileB, "b")

	cache := NewCache()
	if res, err := cache.Scanner().Scan(dirA, dirB); err != nil || !res.Published {
		t.Fatalf("initial scan: res=%+v err=%v", res, err)
	}

	entered := make(chan struct{})
	release := make(chan struct{})
	scanner := cache.Scanner()
	scanner.BeforePublish = func() {
		close(entered)
		<-release
	}
	done := make(chan Result, 1)
	go func() {
		res, err := scanner.Scan(dirA, dirB)
		if err != nil {
			t.Errorf("scan: %v", err)
		}
		done <- res
	}()

	<-entered
	recreate(t, cache, fileB, "b2") // mutate only dirB
	close(release)
	res := <-done

	if res.Published {
		t.Fatalf("publish accepted although baseline of %s was invalidated", fileB)
	}
	if len(res.Entries) != 2 {
		t.Fatalf("scan covered %d entries, want 2 across both dirs", len(res.Entries))
	}
	if _, ok := cache.Entry(fileB); ok {
		t.Fatal("cache updated despite rejected publish")
	}
}

// TestPublishAcceptedWhenBaselinesValid covers the uncontended case:
// with no interleaved mutation, a multi-dir scan publishes its entries.
func TestPublishAcceptedWhenBaselinesValid(t *testing.T) {
	dirA := t.TempDir()
	dirB := t.TempDir()
	fileA := filepath.Join(dirA, "a.txt")
	fileB := filepath.Join(dirB, "b.txt")
	writeFile(t, fileA, "aaa")
	writeFile(t, fileB, "bb")

	cache := NewCache()
	res, err := cache.Scanner().Scan(dirA, dirB)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if !res.Published {
		t.Fatal("publish rejected without any concurrent mutation")
	}
	if len(res.Entries) != 2 {
		t.Fatalf("got %d entries, want 2", len(res.Entries))
	}
	for path, size := range map[string]int64{fileA: 3, fileB: 2} {
		e, ok := cache.Entry(path)
		if !ok {
			t.Fatalf("cache missing entry for %s", path)
		}
		if e.Size != size {
			t.Fatalf("entry %s size = %d, want %d", path, e.Size, size)
		}
		if e.Generation != cache.Generation(path) {
			t.Fatalf("entry %s generation %d != current %d",
				path, e.Generation, cache.Generation(path))
		}
	}
}

// TestMutationOutsideScanScopeKeepsBaselineValid recreates a path that
// is not covered by the scan; the publish must still be accepted.
func TestMutationOutsideScanScopeKeepsBaselineValid(t *testing.T) {
	dirA := t.TempDir()
	dirB := t.TempDir()
	fileA := filepath.Join(dirA, "a.txt")
	fileB := filepath.Join(dirB, "b.txt")
	writeFile(t, fileA, "a")
	writeFile(t, fileB, "b")

	cache := NewCache()
	if res, err := cache.Scanner().Scan(dirA, dirB); err != nil || !res.Published {
		t.Fatalf("initial scan: res=%+v err=%v", res, err)
	}

	entered := make(chan struct{})
	release := make(chan struct{})
	scanner := cache.Scanner()
	scanner.BeforePublish = func() {
		close(entered)
		<-release
	}
	done := make(chan Result, 1)
	go func() {
		res, err := scanner.Scan(dirA) // only dirA is scanned
		if err != nil {
			t.Errorf("scan: %v", err)
		}
		done <- res
	}()

	<-entered
	recreate(t, cache, fileB, "b2") // outside the scan scope
	close(release)
	res := <-done

	if !res.Published {
		t.Fatal("publish rejected although every scanned baseline stayed valid")
	}
}
