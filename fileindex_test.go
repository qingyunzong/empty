package fileindex

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	// Pin a distinct mtime so the new file's signature provably differs
	// from any previous file at the same path, regardless of the
	// filesystem's mtime granularity.
	mtime := time.Now().Add(time.Duration(len(content)) * time.Second)
	if err := os.Chtimes(path, mtime, mtime); err != nil {
		t.Fatal(err)
	}
}

// sigSet strips generations so an asynchronously published result can be
// compared with a synchronous rescan of the same directories.
func sigSet(entries []Entry) map[string]Entry {
	out := make(map[string]Entry, len(entries))
	for _, e := range entries {
		e.Generation = 0
		out[e.Path] = e
	}
	return out
}

// TestPublishRejectsStaleBaselineAfterPathReuse uses a barrier to
// interleave a delete+recreate of the same path (plus a synchronous
// rescan that observes it) between Collect and Publish of an async scan
// covering multiple directories. The stale publish must be rejected and
// the cache must remain exactly what the synchronous rescan produced.
func TestPublishRejectsStaleBaselineAfterPathReuse(t *testing.T) {
	tmp := t.TempDir()
	dirA := filepath.Join(tmp, "a")
	dirB := filepath.Join(tmp, "b")
	writeFile(t, filepath.Join(dirA, "keep.txt"), "keep")
	reused := filepath.Join(dirB, "reused.txt")
	writeFile(t, reused, "old content")

	c := NewCache()
	if _, err := c.Rescan(dirA, dirB); err != nil {
		t.Fatal(err)
	}

	entered := make(chan struct{})
	release := make(chan struct{})
	published := make(chan bool, 1)

	// Async scan goroutine: begin, collect, then block at the barrier
	// inside BeforePublish until the mutation has landed.
	go func() {
		s := c.Begin(dirA, dirB)
		if err := s.Collect(); err != nil {
			t.Errorf("collect: %v", err)
		}
		s.BeforePublish = func() {
			close(entered)
			<-release
		}
		published <- s.Publish()
	}()

	<-entered // scan has collected and is about to publish

	// Path reuse: delete and recreate the same path with new content,
	// then let a synchronous rescan observe it.
	if err := os.Remove(reused); err != nil {
		t.Fatal(err)
	}
	writeFile(t, reused, "new content -- recreated at same path")
	syncEntries, err := c.Rescan(dirA, dirB)
	if err != nil {
		t.Fatal(err)
	}

	close(release)

	if <-published {
		t.Fatal("stale async publish was accepted; want rejection")
	}

	// The cache must be exactly the synchronous rescan result: the
	// stale async observation of the old file must not have leaked in.
	got := c.Snapshot(dirA, dirB)
	if !reflect.DeepEqual(got, syncEntries) {
		t.Fatalf("cache diverged from synchronous rescan\ngot:  %+v\nwant: %+v", got, syncEntries)
	}
	for _, e := range got {
		if e.Path == reused && e.Size == int64(len("old content")) {
			t.Fatalf("stale entry for reused path survived: %+v", e)
		}
	}
}

// TestPublishAcceptsWhenBaselineIntact verifies that an async scan over
// multiple directories publishes when nothing changed, and that its
// result matches a synchronous rescan of the same directories.
func TestPublishAcceptsWhenBaselineIntact(t *testing.T) {
	tmp := t.TempDir()
	dirA := filepath.Join(tmp, "a")
	dirB := filepath.Join(tmp, "b")
	writeFile(t, filepath.Join(dirA, "one.txt"), "one")
	writeFile(t, filepath.Join(dirB, "zero.txt"), "zero")

	c := NewCache()
	if _, err := c.Rescan(dirA, dirB); err != nil {
		t.Fatal(err)
	}

	// New file appears after the baseline rescan but before the async
	// scan starts; the scan itself observes it.
	writeFile(t, filepath.Join(dirB, "two.txt"), "two")

	s := c.Begin(dirA, dirB)
	if err := s.Collect(); err != nil {
		t.Fatal(err)
	}
	if !s.Publish() {
		t.Fatal("publish rejected with intact baseline; want acceptance")
	}

	syncEntries, err := c.Rescan(dirA, dirB)
	if err != nil {
		t.Fatal(err)
	}
	got := c.Snapshot(dirA, dirB)
	if !reflect.DeepEqual(sigSet(got), sigSet(syncEntries)) {
		t.Fatalf("async publish diverged from synchronous rescan\ngot:  %+v\nwant: %+v", sigSet(got), sigSet(syncEntries))
	}
	if _, ok := sigSet(got)[filepath.Join(dirB, "two.txt")]; !ok {
		t.Fatal("published result missing file observed during collect")
	}
}

// TestPublishRejectsDeletionOnly covers baseline invalidation by pure
// deletion (no recreate) in one of several scanned directories.
func TestPublishRejectsDeletionOnly(t *testing.T) {
	tmp := t.TempDir()
	dirA := filepath.Join(tmp, "a")
	dirB := filepath.Join(tmp, "b")
	victim := filepath.Join(dirB, "gone.txt")
	writeFile(t, filepath.Join(dirA, "stay.txt"), "stay")
	writeFile(t, victim, "gone")

	c := NewCache()
	if _, err := c.Rescan(dirA, dirB); err != nil {
		t.Fatal(err)
	}

	s := c.Begin(dirA, dirB)
	if err := s.Collect(); err != nil {
		t.Fatal(err)
	}

	if err := os.Remove(victim); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Rescan(dirB); err != nil {
		t.Fatal(err)
	}

	if s.Publish() {
		t.Fatal("publish accepted after baseline path was deleted; want rejection")
	}
	// dirA was untouched by the interfering rescan and must be intact.
	for _, e := range c.Snapshot(dirA) {
		if e.Path == filepath.Join(dirA, "stay.txt") {
			return
		}
	}
	t.Fatal("untouched directory lost entries after rejected publish")
}
