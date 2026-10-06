package objstore

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func openTemp(t *testing.T) *Store {
	t.Helper()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return s
}

func mustBlob(t *testing.T, s *Store, data string) Hash {
	t.Helper()
	h, err := s.PutBlob([]byte(data))
	if err != nil {
		t.Fatalf("PutBlob: %v", err)
	}
	return h
}

func mustTree(t *testing.T, s *Store, refs ...Hash) Hash {
	t.Helper()
	h, err := s.PutTree(refs)
	if err != nil {
		t.Fatalf("PutTree: %v", err)
	}
	return h
}

func mustRoot(t *testing.T, s *Store, name string, h Hash) {
	t.Helper()
	if err := s.AddRoot(name, h); err != nil {
		t.Fatalf("AddRoot(%q): %v", name, err)
	}
}

func mustExist(t *testing.T, s *Store, h Hash) {
	t.Helper()
	if _, err := s.Get(h); err != nil {
		t.Fatalf("expected object %s to exist: %v", h, err)
	}
}

func mustNotExist(t *testing.T, s *Store, h Hash) {
	t.Helper()
	if _, err := s.Get(h); !errors.Is(err, ErrNotExist) {
		t.Fatalf("expected object %s to be gone, got err=%v", h, err)
	}
}

// mustClosureExist verifies every object reachable from root is present.
func mustClosureExist(t *testing.T, s *Store, root Hash) {
	t.Helper()
	_, err := s.closure(root)
	if err != nil {
		t.Fatalf("closure of %s incomplete: %v", root, err)
	}
}

func TestPutGetBlobAndTree(t *testing.T) {
	s := openTemp(t)
	a := mustBlob(t, s, "alpha")
	b := mustBlob(t, s, "beta")
	tree := mustTree(t, s, a, b)

	obj, err := s.Get(tree)
	if err != nil {
		t.Fatalf("Get tree: %v", err)
	}
	if obj.Kind != KindTree || len(obj.Refs) != 2 || obj.Refs[0] != a || obj.Refs[1] != b {
		t.Fatalf("unexpected tree object: %+v", obj)
	}
	blob, err := s.Get(a)
	if err != nil {
		t.Fatalf("Get blob: %v", err)
	}
	if string(blob.Data) != "alpha" {
		t.Fatalf("unexpected blob data: %q", blob.Data)
	}
}

func TestPutTreeRejectsMissingRefs(t *testing.T) {
	s := openTemp(t)
	missing := HashBlob([]byte("never uploaded"))
	if _, err := s.PutTree([]Hash{missing}); !errors.Is(err, ErrNotExist) {
		t.Fatalf("expected ErrNotExist, got %v", err)
	}
}

func TestAddRootRejectsMissingObject(t *testing.T) {
	s := openTemp(t)
	missing := HashBlob([]byte("ghost"))
	if err := s.AddRoot("v1", missing); !errors.Is(err, ErrNotExist) {
		t.Fatalf("expected ErrNotExist, got %v", err)
	}
}

func TestRootsPersistAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	h := mustBlob(t, s, "versioned")
	mustRoot(t, s, "v1", h)

	s2, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if got := s2.Roots()["v1"]; got != h {
		t.Fatalf("root not persisted: got %q want %q", got, h)
	}
	mustExist(t, s2, h)
}

type crashPanic struct{ stage string }

// TestCrashDuringStatePersist simulates a crash between the tmp-file write
// and the atomic rename, and after the rename. In both cases the reopened
// store must observe a consistent (old or new) state, never a torn one.
func TestCrashDuringStatePersist(t *testing.T) {
	for _, stage := range []string{"tmp", "rename"} {
		t.Run(stage, func(t *testing.T) {
			dir := t.TempDir()
			s, err := Open(dir)
			if err != nil {
				t.Fatal(err)
			}
			h1 := mustBlob(t, s, "first")
			mustRoot(t, s, "v1", h1)

			h2 := mustBlob(t, s, "second")
			s.crashHook = func(st string) {
				if st == stage {
					panic(crashPanic{stage: st})
				}
			}
			func() {
				defer func() {
					if r := recover(); r == nil {
						t.Fatal("expected crash panic")
					}
				}()
				_ = s.AddRoot("v2", h2)
			}()

			// Simulate process death: abandon s, reopen from disk.
			s2, err := Open(dir)
			if err != nil {
				t.Fatalf("reopen after crash at %q: %v", stage, err)
			}
			roots := s2.Roots()
			if roots["v1"] != h1 {
				t.Fatalf("committed root v1 lost after crash at %q", stage)
			}
			// v2 is either fully present or fully absent — never partial.
			if got, ok := roots["v2"]; ok && got != h2 {
				t.Fatalf("torn root v2: got %q want %q", got, h2)
			}
			// No stale tmp files survive recovery.
			leftover, _ := filepath.Glob(filepath.Join(dir, "*.tmp"))
			if len(leftover) != 0 {
				t.Fatalf("stale tmp files after recovery: %v", leftover)
			}
			// Store remains fully usable.
			mustRoot(t, s2, "v3", h2)
			mustExist(t, s2, h2)
		})
	}
}

func TestLeaseExpiryUsesClock(t *testing.T) {
	s := openTemp(t)
	now := time.Now()
	s.now = func() time.Time { return now }

	h := mustBlob(t, s, "temp upload")
	if err := s.AddLease("upload-1", h, time.Hour); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	live := s.liveLeasesLocked()
	s.mu.Unlock()
	if !live[h] {
		t.Fatal("lease should be live before expiry")
	}
	now = now.Add(2 * time.Hour)
	s.mu.Lock()
	live = s.liveLeasesLocked()
	s.mu.Unlock()
	if live[h] {
		t.Fatal("lease should be expired")
	}
}

func TestEvidenceLogPersists(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	orphan := mustBlob(t, s, "orphan")
	if _, err := s.RunGC(); err != nil {
		t.Fatal(err)
	}
	s2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	evs, err := s2.ReadEvidence()
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 1 || evs[0].Hash != orphan {
		t.Fatalf("expected 1 evidence record for %s, got %+v", orphan, evs)
	}
}

func TestListObjectsSkipsTmp(t *testing.T) {
	s := openTemp(t)
	h := mustBlob(t, s, "real")
	// Plant a stale tmp file as an interrupted upload would leave behind.
	if err := os.WriteFile(filepath.Join(s.objectsDir(), "partial.tmp"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	all, err := s.listObjects()
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 1 || all[0] != h {
		t.Fatalf("expected only %s, got %v", h, all)
	}
}

func TestConcurrentPuts(t *testing.T) {
	s := openTemp(t)
	done := make(chan Hash, 64)
	for i := 0; i < 64; i++ {
		go func(i int) {
			h, err := s.PutBlob([]byte(fmt.Sprintf("blob-%d", i)))
			if err != nil {
				t.Error(err)
			}
			done <- h
		}(i)
	}
	for i := 0; i < 64; i++ {
		mustExist(t, s, <-done)
	}
}
