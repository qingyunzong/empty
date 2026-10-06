package objstore

import (
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

// TestGCCollectsUnreachableOnly: unreferenced objects are collected with
// evidence; everything reachable from roots is kept.
func TestGCCollectsUnreachableOnly(t *testing.T) {
	s := openTemp(t)
	a := mustBlob(t, s, "a")
	b := mustBlob(t, s, "b")
	tree := mustTree(t, s, a, b)
	mustRoot(t, s, "v1", tree)

	orphan1 := mustBlob(t, s, "orphan-1")
	orphan2 := mustBlob(t, s, "orphan-2")

	stats, err := s.RunGC()
	if err != nil {
		t.Fatal(err)
	}
	if stats.Deleted != 2 {
		t.Fatalf("expected 2 deletions, got %+v", stats)
	}
	mustExist(t, s, a)
	mustExist(t, s, b)
	mustExist(t, s, tree)
	mustNotExist(t, s, orphan1)
	mustNotExist(t, s, orphan2)

	// Every deletion carries unreachable evidence.
	evs := s.Deletions()
	if len(evs) != 2 {
		t.Fatalf("expected 2 evidence records, got %d", len(evs))
	}
	for _, ev := range evs {
		if ev.Hash != orphan1 && ev.Hash != orphan2 {
			t.Fatalf("evidence for unexpected object: %+v", ev)
		}
		if ev.SnapshotRoots["v1"] != tree {
			t.Fatalf("evidence missing snapshot roots: %+v", ev)
		}
		if ev.RecheckRoots["v1"] != tree {
			t.Fatalf("evidence missing recheck roots: %+v", ev)
		}
		if ev.Reason == "" || ev.Epoch == 0 {
			t.Fatalf("incomplete evidence: %+v", ev)
		}
	}
}

// TestGCNewRootDuringMark uses the AfterMark barrier to add a root to a
// previously unreachable object in the middle of the scan. The recheck pass
// must rescue it.
func TestGCNewRootDuringMark(t *testing.T) {
	s := openTemp(t)
	keep := mustBlob(t, s, "rooted")
	mustRoot(t, s, "v1", keep)

	rescued := mustBlob(t, s, "rescued")
	child := mustBlob(t, s, "rescued-child")
	rescuedTree := mustTree(t, s, rescued, child)

	s.SetBarriers(Barriers{
		AfterMark: func(st *Store) {
			if err := st.AddRoot("v2", rescuedTree); err != nil {
				t.Errorf("barrier AddRoot: %v", err)
			}
		},
	})
	stats, err := s.RunGC()
	if err != nil {
		t.Fatal(err)
	}
	if stats.Deleted != 0 {
		t.Fatalf("nothing may be deleted, got %+v", stats)
	}
	if stats.Protected != 3 {
		t.Fatalf("expected 3 protected objects, got %+v", stats)
	}
	mustClosureExist(t, s, rescuedTree)
	if len(s.Deletions()) != 0 {
		t.Fatalf("no evidence may be written, got %+v", s.Deletions())
	}
}

// TestGCNewRootBeforeDelete uses the BeforeDelete barrier to add a root to
// the exact object about to be deleted — after the recheck pass. The
// gcMu-serialized protection set must save it.
func TestGCNewRootBeforeDelete(t *testing.T) {
	s := openTemp(t)
	victim := mustBlob(t, s, "last-second-root")
	other := mustBlob(t, s, "stays-garbage")

	var once sync.Once
	s.SetBarriers(Barriers{
		BeforeDelete: func(st *Store, h Hash) {
			once.Do(func() {
				if err := st.AddRoot("rescued", victim); err != nil {
					t.Errorf("barrier AddRoot: %v", err)
				}
			})
		},
	})
	stats, err := s.RunGC()
	if err != nil {
		t.Fatal(err)
	}
	mustExist(t, s, victim)
	mustNotExist(t, s, other)
	if stats.Deleted != 1 || stats.Protected != 1 {
		t.Fatalf("unexpected stats: %+v", stats)
	}
	// Evidence exists only for the object that was actually deleted.
	evs := s.Deletions()
	if len(evs) != 1 || evs[0].Hash != other {
		t.Fatalf("unexpected evidence: %+v", evs)
	}
}

// TestGCRootReplacementDuringScan replaces a version root mid-scan. Objects
// reachable only from the old root are collected with evidence; objects
// reachable from the new root survive even though the snapshot never saw it.
func TestGCRootReplacementDuringScan(t *testing.T) {
	s := openTemp(t)
	shared := mustBlob(t, s, "shared")
	oldOnly := mustBlob(t, s, "old-only")
	newOnly := mustBlob(t, s, "new-only")
	oldTree := mustTree(t, s, shared, oldOnly)
	newTree := mustTree(t, s, shared, newOnly)
	mustRoot(t, s, "latest", oldTree)

	s.SetBarriers(Barriers{
		AfterSnapshot: func(st *Store) {
			if err := st.AddRoot("latest", newTree); err != nil {
				t.Errorf("barrier replace root: %v", err)
			}
		},
	})
	stats, err := s.RunGC()
	if err != nil {
		t.Fatal(err)
	}
	// oldTree and oldOnly were reachable in the snapshot, so they survive
	// this cycle; newTree/newOnly became reachable after the snapshot and
	// must be rescued by the recheck.
	mustClosureExist(t, s, newTree)
	mustClosureExist(t, s, oldTree)

	// Second cycle with no barriers: the old-only chain is now unreachable.
	s.SetBarriers(Barriers{})
	stats, err = s.RunGC()
	if err != nil {
		t.Fatal(err)
	}
	if stats.Deleted != 2 {
		t.Fatalf("expected 2 deletions, got %+v", stats)
	}
	mustNotExist(t, s, oldTree)
	mustNotExist(t, s, oldOnly)
	mustClosureExist(t, s, newTree)

	evs := s.Deletions()
	if len(evs) != 2 {
		t.Fatalf("expected evidence for 2 deletions, got %d", len(evs))
	}
	for _, ev := range evs {
		if ev.RecheckRoots["latest"] != newTree {
			t.Fatalf("evidence must show the replacement root: %+v", ev)
		}
	}
}

// TestGCTempUploadLeases: a leased temporary upload survives GC; after the
// lease is released (or expires) it becomes collectable.
func TestGCTempUploadLeases(t *testing.T) {
	s := openTemp(t)
	now := time.Now()
	s.now = func() time.Time { return now }

	upload := mustBlob(t, s, "temp-upload")
	if err := s.AddLease("u1", upload, time.Hour); err != nil {
		t.Fatal(err)
	}
	stats, err := s.RunGC()
	if err != nil {
		t.Fatal(err)
	}
	if stats.Deleted != 0 {
		t.Fatalf("leased upload must survive GC: %+v", stats)
	}
	mustExist(t, s, upload)

	// Expire the lease: the upload is now collectable.
	now = now.Add(2 * time.Hour)
	stats, err = s.RunGC()
	if err != nil {
		t.Fatal(err)
	}
	if stats.Deleted != 1 {
		t.Fatalf("expected expired upload to be collected: %+v", stats)
	}
	mustNotExist(t, s, upload)

	// A released lease also frees the object.
	upload2 := mustBlob(t, s, "temp-upload-2")
	if err := s.AddLease("u2", upload2, time.Hour); err != nil {
		t.Fatal(err)
	}
	if err := s.ReleaseLease("u2"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RunGC(); err != nil {
		t.Fatal(err)
	}
	mustNotExist(t, s, upload2)
}

// TestGCConcurrentRootAdditions stresses the race between GC deletion and
// concurrent root creation: while GC runs, goroutines keep adding roots to
// previously unreachable objects. After the cycle, every root's closure
// must be fully intact and no reachable object may have been deleted.
func TestGCConcurrentRootAdditions(t *testing.T) {
	s := openTemp(t)
	base := mustBlob(t, s, "base")
	mustRoot(t, s, "base", base)

	const uploads = 32
	candidates := make([]Hash, uploads)
	for i := range candidates {
		candidates[i] = mustBlob(t, s, fmt.Sprintf("candidate-%02d", i))
	}

	// Widen the race window: pause briefly before every deletion.
	s.SetBarriers(Barriers{
		BeforeDelete: func(st *Store, h Hash) {
			time.Sleep(time.Millisecond)
		},
	})

	gcDone := make(chan error, 1)
	go func() {
		_, err := s.RunGC()
		gcDone <- err
	}()

	// Concurrently root half of the candidates while GC is sweeping.
	var wg sync.WaitGroup
	rooted := map[int]bool{}
	var mu sync.Mutex
	for i := 0; i < uploads; i += 2 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if err := s.AddRoot(fmt.Sprintf("r-%02d", i), candidates[i]); err != nil {
				// Acceptable only if GC already collected the object before
				// the root was added — AddRoot must then fail cleanly.
				if !errors.Is(err, ErrNotExist) {
					t.Errorf("AddRoot: %v", err)
				}
				return
			}
			mu.Lock()
			rooted[i] = true
			mu.Unlock()
		}(i)
	}
	wg.Wait()
	if err := <-gcDone; err != nil {
		t.Fatal(err)
	}

	// Every successfully added root must have a fully intact closure.
	for i := range rooted {
		mustClosureExist(t, s, candidates[i])
	}
	// Every deletion must have evidence, and no deleted object may be
	// reachable from any current root.
	evs := s.Deletions()
	reachable, err := s.markFrom(s.Roots(), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, ev := range evs {
		if reachable[ev.Hash] {
			t.Fatalf("reachable object %s was deleted", ev.Hash)
		}
		mustNotExist(t, s, ev.Hash)
	}
}

// TestCrashDuringGC kills the store mid-sweep via the BeforeDelete barrier.
// After reopening, all evidence on disk must be valid, every deleted object
// must have evidence, and reachable objects must be intact.
func TestCrashDuringGC(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	keep := mustBlob(t, s, "keep")
	mustRoot(t, s, "v1", keep)
	for i := 0; i < 8; i++ {
		mustBlob(t, s, fmt.Sprintf("garbage-%d", i))
	}

	deletes := 0
	s.SetBarriers(Barriers{
		BeforeDelete: func(st *Store, h Hash) {
			deletes++
			if deletes == 3 {
				panic(crashPanic{stage: "gc-sweep"})
			}
		},
	})
	func() {
		defer func() {
			if r := recover(); r == nil {
				t.Fatal("expected crash panic")
			}
		}()
		_, _ = s.RunGC()
	}()

	// Reopen and verify consistency.
	s2, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen after GC crash: %v", err)
	}
	mustExist(t, s2, keep)
	if got := s2.Roots()["v1"]; got != keep {
		t.Fatalf("root lost after crash: %q", got)
	}
	evs, err := s2.ReadEvidence()
	if err != nil {
		t.Fatalf("evidence log unreadable after crash: %v", err)
	}
	if len(evs) < 2 {
		t.Fatalf("expected evidence for completed deletions, got %d", len(evs))
	}
	for _, ev := range evs {
		// Evidence is fsynced before deletion, so an evidenced object may
		// still exist (crash between evidence and remove) — but a deleted
		// object must always have evidence. Here: evidence must be complete.
		if ev.Hash == "" || ev.Reason == "" || ev.SnapshotRoots["v1"] != keep {
			t.Fatalf("incomplete evidence after crash: %+v", ev)
		}
	}
	// A fresh GC cycle finishes the job cleanly.
	stats, err := s2.RunGC()
	if err != nil {
		t.Fatal(err)
	}
	mustExist(t, s2, keep)
	all, err := s2.listObjects()
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 1 || all[0] != keep {
		t.Fatalf("expected only the rooted object to remain, got %v (stats %+v)", all, stats)
	}
}

// TestGCRejectsConcurrentCycles ensures only one GC cycle runs at a time.
func TestGCRejectsConcurrentCycles(t *testing.T) {
	s := openTemp(t)
	mustBlob(t, s, "x")
	started := make(chan struct{})
	release := make(chan struct{})
	s.SetBarriers(Barriers{
		AfterMark: func(st *Store) {
			close(started)
			<-release
		},
	})
	gcDone := make(chan error, 1)
	go func() {
		_, err := s.RunGC()
		gcDone <- err
	}()
	<-started
	if _, err := s.RunGC(); !errors.Is(err, ErrGCRunning) {
		t.Fatalf("expected ErrGCRunning, got %v", err)
	}
	close(release)
	if err := <-gcDone; err != nil {
		t.Fatal(err)
	}
}
