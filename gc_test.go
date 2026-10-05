package objstore

import (
	"fmt"
	"sync"
	"testing"
	"time"
)

// TestConcurrentRootAdditionDuringGC verifies that a root added while
// the collector is sweeping cannot have its (newly reachable) objects
// deleted: SetRoot acts as a write barrier.
func TestConcurrentRootAdditionDuringGC(t *testing.T) {
	clk := newFakeClock()
	var s *Store
	hooks := Hooks{
		// Phase barrier: mark is done, sweep is about to start. Add a
		// new root pointing at an object the mark phase never saw.
		AfterMark: func() {
			orphan, err := s.Put([]byte("late-root-target"), nil)
			if err != nil {
				t.Errorf("Put orphan: %v", err)
				return
			}
			clk.advance(2 * time.Minute) // expire its lease, so only the barrier can save it
			if err := s.SetRoot("late", orphan); err != nil {
				t.Errorf("SetRoot late: %v", err)
			}
		},
	}
	clk = newFakeClock()
	s = openTestStore(t, t.TempDir(), clk, hooks)

	// Pre-existing reachable tree and expired garbage.
	leaf, _ := s.Put([]byte("leaf"), nil)
	top, _ := s.Put([]byte("top"), []ID{leaf})
	s.SetRoot("v1", top)
	garbage, _ := s.Put([]byte("garbage"), nil)
	clk.advance(2 * time.Minute)

	evs, err := s.Collect()
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	for _, ev := range evs {
		if ev.Object != garbage {
			t.Fatalf("unexpected deletion during concurrent root add: %+v", ev)
		}
	}
	late := s.Roots()["late"]
	if late == "" {
		t.Fatal("late root missing")
	}
	if !s.Has(late) {
		t.Fatal("object reachable only via concurrently added root was swept")
	}
	if !s.Has(top) || !s.Has(leaf) {
		t.Fatal("reachable tree deleted")
	}
	if s.Has(garbage) {
		t.Fatal("garbage survived")
	}
}

// TestRootReplacementDuringScan replaces a root between the root
// snapshot and the sweep: the old tree becomes collectable, the new
// tree must survive even though marking started before it was rooted.
func TestRootReplacementDuringScan(t *testing.T) {
	clk := newFakeClock()
	var s *Store
	var newTop ID
	hooks := Hooks{
		AfterRootSnapshot: func() {
			// Build and root a brand-new tree mid-scan.
			nl, err := s.Put([]byte("new-leaf"), nil)
			if err != nil {
				t.Errorf("Put: %v", err)
				return
			}
			nt, err := s.Put([]byte("new-top"), []ID{nl})
			if err != nil {
				t.Errorf("Put: %v", err)
				return
			}
			newTop = nt
			clk.advance(2 * time.Minute)                // expire leases so only roots protect
			if err := s.SetRoot("v1", nt); err != nil { // replace old root
				t.Errorf("SetRoot: %v", err)
			}
		},
	}
	clk = newFakeClock()
	s = openTestStore(t, t.TempDir(), clk, hooks)

	oldLeaf, _ := s.Put([]byte("old-leaf"), nil)
	oldTop, _ := s.Put([]byte("old-top"), []ID{oldLeaf})
	s.SetRoot("v1", oldTop)
	clk.advance(2 * time.Minute)

	// Cycle 1: the old tree was still rooted when the snapshot was
	// taken, so it is floating garbage and survives this cycle. The
	// critical property is that the replacement tree, rooted mid-scan,
	// is not swept.
	evs, err := s.Collect()
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if len(evs) != 0 {
		t.Fatalf("unexpected deletions in replacement cycle: %+v", evs)
	}
	if !s.Has(newTop) {
		t.Fatal("new root target swept despite write barrier")
	}
	newLeafObj, err := s.Get(newTop)
	if err != nil {
		t.Fatalf("Get newTop: %v", err)
	}
	if !s.Has(newLeafObj.Refs[0]) {
		t.Fatal("new tree child swept despite write barrier")
	}

	// Cycle 2: with the old root replaced, its tree is now unreachable
	// and lease-expired, so it is collected with evidence.
	evs, err = s.Collect()
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if len(evs) != 2 {
		t.Fatalf("expected old tree (2 objects) collected, got %+v", evs)
	}
	for _, ev := range evs {
		if ev.Object != oldTop && ev.Object != oldLeaf {
			t.Fatalf("unexpected deletion: %+v", ev)
		}
		if ev.Roots["v1"] != newTop {
			t.Fatalf("evidence root snapshot wrong: %v", ev.Roots)
		}
	}
	if s.Has(oldTop) || s.Has(oldLeaf) {
		t.Fatal("replaced tree survived second GC")
	}
	if !s.Has(newTop) || !s.Has(newLeafObj.Refs[0]) {
		t.Fatal("replacement tree deleted")
	}
}

// TestCrashMidSweepRecovery kills a GC cycle between journaling a
// deletion and applying it, then verifies recovery replays the
// journaled deletions and never resurrects or loses reachable data.
func TestCrashMidSweepRecovery(t *testing.T) {
	clk := newFakeClock()
	dir := t.TempDir()

	var s *Store
	crashed := make(chan struct{})
	var once sync.Once
	hooks := Hooks{
		BeforeDelete: func(id ID) error {
			// Crash after the first evidenced deletion is journaled but
			// before its file is removed.
			once.Do(func() { close(crashed) })
			<-crashed // block every subsequent delete too
			return fmt.Errorf("simulated crash")
		},
	}
	s = openTestStore(t, dir, clk, hooks)

	leaf, _ := s.Put([]byte("leaf"), nil)
	top, _ := s.Put([]byte("top"), []ID{leaf})
	s.SetRoot("v1", top)
	var garbage []ID
	for i := 0; i < 3; i++ {
		g, _ := s.Put([]byte(fmt.Sprintf("garbage-%d", i)), nil)
		garbage = append(garbage, g)
	}
	clk.advance(2 * time.Minute)

	if _, err := s.Collect(); err == nil {
		t.Fatal("expected crash error from Collect")
	}
	// Simulate process death: journal is fsynced, in-memory state lost.
	s.debugCrash = true
	s.Close()

	// Recover.
	s2 := openTestStore(t, dir, clk, Hooks{})
	if !s2.Has(top) || !s2.Has(leaf) {
		t.Fatal("reachable tree lost after crash recovery")
	}
	remaining := 0
	for _, g := range garbage {
		if s2.Has(g) {
			remaining++
		}
	}
	if remaining == len(garbage) {
		t.Fatal("no journaled deletion was replayed during recovery")
	}

	// A follow-up GC finishes the job and only collects what is left.
	evs, err := s2.Collect()
	if err != nil {
		t.Fatalf("post-recovery Collect: %v", err)
	}
	for _, g := range garbage {
		if s2.Has(g) {
			t.Fatalf("garbage %s survived recovery + re-GC", g)
		}
	}
	if !s2.Has(top) || !s2.Has(leaf) {
		t.Fatal("reachable tree deleted by post-recovery GC")
	}
	for _, ev := range evs {
		if ev.Reason == "" || ev.Roots["v1"] != top {
			t.Fatalf("post-recovery deletion missing evidence: %+v", ev)
		}
	}
}

// TestConcurrentPutAndRootStress hammers the store with concurrent
// Puts, root replacements and GC cycles under -race; no reachable
// object may ever be deleted.
func TestConcurrentPutAndRootStress(t *testing.T) {
	// Lease must comfortably cover the window between a child Put and
	// its parent Put; otherwise the child is legitimately collectable.
	s, err := Open(t.TempDir(), &Options{MinAge: 500 * time.Millisecond})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	base, _ := s.Put([]byte("base"), nil)
	s.SetRoot("base", base)

	var wg sync.WaitGroup
	errCh := make(chan error, 64)

	// Writers: create trees and (re)point roots at them. Bounded
	// iterations keep the run finite even under -race, where each
	// journaled delete costs an fsync.
	for w := 0; w < 4; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < 30; i++ {
				child, err := s.Put([]byte(fmt.Sprintf("w%d-%d-child", w, i)), []ID{base})
				if err != nil {
					errCh <- err
					return
				}
				parent, err := s.Put([]byte(fmt.Sprintf("w%d-%d-parent", w, i)), []ID{child})
				if err != nil {
					errCh <- err
					return
				}
				if err := s.SetRoot(fmt.Sprintf("w%d", w), parent); err != nil {
					errCh <- err
					return
				}
			}
		}(w)
	}

	// Collector runs concurrently with the writers.
	collectDone := make(chan error, 1)
	go func() {
		for i := 0; i < 10; i++ {
			if _, err := s.Collect(); err != nil {
				collectDone <- err
				return
			}
		}
		collectDone <- nil
	}()
	wg.Wait()
	if err := <-collectDone; err != nil {
		t.Fatalf("Collect: %v", err)
	}
	close(errCh)
	for err := range errCh {
		t.Fatalf("concurrent op failed: %v", err)
	}

	// Everything reachable from the final root set must be intact.
	roots := s.Roots()
	reach := make(map[ID]bool)
	var walk func(id ID)
	walk = func(id ID) {
		if reach[id] {
			return
		}
		reach[id] = true
		obj, err := s.Get(id)
		if err != nil {
			t.Fatalf("reachable object %s missing after stress: %v", id, err)
		}
		for _, r := range obj.Refs {
			walk(r)
		}
	}
	for _, root := range roots {
		walk(root)
	}
	if len(reach) == 0 {
		t.Fatal("no roots survived stress test")
	}
}
