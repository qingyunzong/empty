package snapshot

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

func putFiles(t *testing.T, s *MemStore, keys ...string) {
	t.Helper()
	for _, k := range keys {
		if err := s.Put(context.Background(), k, []byte("data:"+k)); err != nil {
			t.Fatal(err)
		}
	}
}

func mustCommit(t *testing.T, m *Manager, manifest Manifest) {
	t.Helper()
	if err := m.Commit(context.Background(), manifest); err != nil {
		t.Fatalf("commit %s: %v", manifest.ID, err)
	}
}

func open(t *testing.T, s Store) *Manager {
	t.Helper()
	m, err := Open(context.Background(), s)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	return m
}

func TestCommitChainPublishesHeadAtomically(t *testing.T) {
	ctx := context.Background()
	s := NewMemStore()
	putFiles(t, s, "sst/1.sst", "sst/2.sst", "delta/a")
	m := open(t, s)

	mustCommit(t, m, Manifest{ID: "c1", SSTs: []string{"sst/1.sst"}})
	mustCommit(t, m, Manifest{ID: "c2", Parent: "c1", SSTs: []string{"sst/1.sst", "sst/2.sst"}, Private: []string{"delta/a"}})

	head, ok := m.Head()
	if !ok || head.ID != "c2" {
		t.Fatalf("head = %v, %v; want c2", head.ID, ok)
	}
	if got, _ := s.Get(ctx, headKey); string(got) != "c2" {
		t.Fatalf("HEAD object = %q; want c2", got)
	}
	if head.Parent != "c1" {
		t.Fatalf("head.Parent = %q; want c1", head.Parent)
	}
	// No staging file may survive a successful commit.
	keys, _ := s.List(ctx, manifestDir)
	for _, k := range keys {
		if k == stagingKey("c1") || k == stagingKey("c2") {
			t.Fatalf("staging file leaked: %s", k)
		}
	}
}

func TestCommitRejectsDroppedParentAndDuplicates(t *testing.T) {
	s := NewMemStore()
	m := open(t, s)
	mustCommit(t, m, Manifest{ID: "c1"})
	mustCommit(t, m, Manifest{ID: "c1-child", Parent: "c1"})
	if err := m.Cancel(context.Background(), "c1"); err != nil {
		t.Fatal(err)
	}
	// c1 survives as a dropped generation because c1-child is active.
	if err := m.Commit(context.Background(), Manifest{ID: "c2", Parent: "c1"}); !errors.Is(err, ErrCheckpointDropped) {
		t.Fatalf("commit on dropped parent: %v", err)
	}
	mustCommit(t, m, Manifest{ID: "c3"})
	if err := m.Commit(context.Background(), Manifest{ID: "c3"}); !errors.Is(err, ErrCheckpointExists) {
		t.Fatalf("duplicate commit: %v", err)
	}
	if err := m.Commit(context.Background(), Manifest{ID: "c4", Parent: "nope"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("commit with missing parent: %v", err)
	}
}

func TestCancelKeepsFilesReferencedByActiveDescendants(t *testing.T) {
	ctx := context.Background()
	s := NewMemStore()
	putFiles(t, s, "sst/base.sst", "delta/1", "delta/2")
	m := open(t, s)

	mustCommit(t, m, Manifest{ID: "c1", SSTs: []string{"sst/base.sst"}, Private: []string{"delta/1"}})
	mustCommit(t, m, Manifest{ID: "c2", Parent: "c1", SSTs: []string{"sst/base.sst"}, Private: []string{"delta/2"}})

	if err := m.Cancel(ctx, "c1"); err != nil {
		t.Fatal(err)
	}
	// c1 is dropped but c2 is an active descendant: nothing is reclaimed.
	for _, k := range []string{"sst/base.sst", "delta/1", "delta/2", manifestKey("c1"), manifestKey("c2")} {
		if _, err := s.Get(ctx, k); err != nil {
			t.Fatalf("%s reclaimed while active descendant exists: %v", k, err)
		}
	}
	if got := m.ActiveFiles(); len(got) != 3 {
		t.Fatalf("active files = %v; want 3 entries", got)
	}

	// Dropping the last active descendant cascades reclamation.
	if err := m.Cancel(ctx, "c2"); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"sst/base.sst", "delta/1", "delta/2", manifestKey("c1"), manifestKey("c2")} {
		if _, err := s.Get(ctx, k); !errors.Is(err, ErrNotFound) {
			t.Fatalf("%s still present after cascade: %v", k, err)
		}
	}
	if got := m.ActiveFiles(); len(got) != 0 {
		t.Fatalf("active files after cascade = %v; want none", got)
	}
}

func TestExpireKeepsSharedSSTReferencedBySibling(t *testing.T) {
	ctx := context.Background()
	s := NewMemStore()
	putFiles(t, s, "sst/shared.sst", "delta/left", "delta/right")
	m := open(t, s)

	mustCommit(t, m, Manifest{ID: "root"})
	mustCommit(t, m, Manifest{ID: "left", Parent: "root", SSTs: []string{"sst/shared.sst"}, Private: []string{"delta/left"}})
	mustCommit(t, m, Manifest{ID: "right", Parent: "root", SSTs: []string{"sst/shared.sst"}, Private: []string{"delta/right"}})

	if err := m.Expire(ctx, "left"); err != nil {
		t.Fatal(err)
	}
	// The private delta of the expired branch is reclaimed; the shared SST
	// is still referenced by the active sibling and must survive.
	if _, err := s.Get(ctx, "delta/left"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("delta/left should be reclaimed: %v", err)
	}
	if _, err := s.Get(ctx, "sst/shared.sst"); err != nil {
		t.Fatalf("shared SST reclaimed while sibling active: %v", err)
	}
	if _, err := s.Get(ctx, "delta/right"); err != nil {
		t.Fatalf("sibling private file reclaimed: %v", err)
	}
}

func TestCorruptManifestStopsOpen(t *testing.T) {
	ctx := context.Background()
	s := NewMemStore()
	m := open(t, s)
	mustCommit(t, m, Manifest{ID: "c1"})
	mustCommit(t, m, Manifest{ID: "c2", Parent: "c1"})

	// Corrupt one byte of the c1 manifest payload.
	data, err := s.Get(ctx, manifestKey("c1"))
	if err != nil {
		t.Fatal(err)
	}
	data[len(data)/2] ^= 0xff
	if err := s.Put(ctx, manifestKey("c1"), data); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(ctx, s); !errors.Is(err, ErrCorruptManifest) {
		t.Fatalf("open with corrupt manifest: %v; want ErrCorruptManifest", err)
	}
}

func TestDanglingParentStopsOpen(t *testing.T) {
	ctx := context.Background()
	s := NewMemStore()
	m := open(t, s)
	mustCommit(t, m, Manifest{ID: "c1"})
	mustCommit(t, m, Manifest{ID: "c2", Parent: "c1"})

	// Simulate an externally deleted parent manifest. Open must stop
	// instead of guessing a new parent chain from the object listing.
	if err := s.Delete(ctx, manifestKey("c1")); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(ctx, s); !errors.Is(err, ErrCorruptManifest) {
		t.Fatalf("open with dangling parent: %v; want ErrCorruptManifest", err)
	}
}

func TestOpenIgnoresStagingFilesAndForeignObjects(t *testing.T) {
	ctx := context.Background()
	s := NewMemStore()
	m := open(t, s)
	mustCommit(t, m, Manifest{ID: "c1"})

	// A leftover staging file from an interrupted commit and an unrelated
	// object under the manifest prefix must not become checkpoints.
	if err := s.Put(ctx, stagingKey("c2"), []byte("partial write")); err != nil {
		t.Fatal(err)
	}
	if err := s.Put(ctx, manifestDir+"notes.txt", []byte("not a manifest")); err != nil {
		t.Fatal(err)
	}
	m2 := open(t, s)
	if _, ok := m2.Get("c2"); ok {
		t.Fatal("staging file was promoted to a checkpoint")
	}
	head, ok := m2.Head()
	if !ok || head.ID != "c1" {
		t.Fatalf("head = %v, %v; want c1", head.ID, ok)
	}
}

func TestReopenRestoresReferenceCounts(t *testing.T) {
	ctx := context.Background()
	s := NewMemStore()
	putFiles(t, s, "sst/a.sst", "delta/1")
	m := open(t, s)
	mustCommit(t, m, Manifest{ID: "c1", SSTs: []string{"sst/a.sst"}})
	mustCommit(t, m, Manifest{ID: "c2", Parent: "c1", Private: []string{"delta/1"}})
	if err := m.Cancel(ctx, "c1"); err != nil {
		t.Fatal(err)
	}

	// Reopen from the persisted state: c1 is dropped but still referenced
	// by active c2, so its files must survive another cancel of c2 only.
	m2 := open(t, s)
	if err := m2.Cancel(ctx, "c2"); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"sst/a.sst", "delta/1"} {
		if _, err := s.Get(ctx, k); !errors.Is(err, ErrNotFound) {
			t.Fatalf("%s should be reclaimed after reopen + cascade: %v", k, err)
		}
	}
}

func TestHeadRewindsWhenHeadGenerationReclaimed(t *testing.T) {
	ctx := context.Background()
	s := NewMemStore()
	m := open(t, s)
	mustCommit(t, m, Manifest{ID: "c1"})
	mustCommit(t, m, Manifest{ID: "c2", Parent: "c1"})

	if err := m.Cancel(ctx, "c2"); err != nil {
		t.Fatal(err)
	}
	head, ok := m.Head()
	if !ok || head.ID != "c1" {
		t.Fatalf("head = %v, %v; want c1", head.ID, ok)
	}
	if got, _ := s.Get(ctx, headKey); string(got) != "c1" {
		t.Fatalf("HEAD object = %q; want c1", got)
	}
	// Reopen sees the rewound HEAD.
	m2 := open(t, s)
	if head, ok := m2.Head(); !ok || head.ID != "c1" {
		t.Fatalf("reopened head = %v, %v; want c1", head.ID, ok)
	}
}

func ExampleManager() {
	ctx := context.Background()
	store := NewMemStore()
	mgr, _ := Open(ctx, store)
	_ = mgr.Commit(ctx, Manifest{ID: "chk-1", SSTs: []string{"sst/0001.sst"}})
	_ = mgr.Commit(ctx, Manifest{ID: "chk-2", Parent: "chk-1", Private: []string{"delta/0002"}})
	_ = mgr.Cancel(ctx, "chk-1") // files survive: chk-2 is an active descendant
	head, _ := mgr.Head()
	fmt.Println(head.ID, head.Parent)
	// Output: chk-2 chk-1
}
