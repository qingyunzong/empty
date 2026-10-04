package idalloc

import (
	"errors"
	"sync"
	"testing"
)

func newFileStorage(t *testing.T) *FileStorage {
	t.Helper()
	store, err := NewFileStorage(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStorage: %v", err)
	}
	return store
}

func TestAllocatePersistsAcrossRestart(t *testing.T) {
	store := newFileStorage(t)

	alloc, err := OpenAllocator(store)
	if err != nil {
		t.Fatalf("OpenAllocator: %v", err)
	}
	l1, err := alloc.Allocate("n1", 10)
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}
	l2, err := alloc.Allocate("n2", 5)
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}
	if l1.Start != 1 || l1.End != 10 || l2.Start != 11 || l2.End != 15 {
		t.Fatalf("unexpected leases: %+v %+v", l1, l2)
	}

	// Restart the allocator from disk; new ranges must not overlap old ones.
	alloc2, err := OpenAllocator(store)
	if err != nil {
		t.Fatalf("OpenAllocator after restart: %v", err)
	}
	l3, err := alloc2.Allocate("n1", 7)
	if err != nil {
		t.Fatalf("Allocate after restart: %v", err)
	}
	if l3.Start != 16 || l3.End != 22 {
		t.Fatalf("lease after restart overlaps or regresses: %+v", l3)
	}

	ranges := alloc2.Ranges()
	if len(ranges) != 3 {
		t.Fatalf("expected 3 ranges, got %d", len(ranges))
	}
	for i := 1; i < len(ranges); i++ {
		if ranges[i].Start <= ranges[i-1].End {
			t.Fatalf("overlapping ranges: %+v vs %+v", ranges[i-1], ranges[i])
		}
	}
}

func TestNodeRestartContinuesUnconsumedTail(t *testing.T) {
	store := newFileStorage(t)
	alloc, err := OpenAllocator(store)
	if err != nil {
		t.Fatalf("OpenAllocator: %v", err)
	}

	n := NewNode("n1", store, alloc)
	if err := n.Acquire(10); err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	var got []int64
	for i := 0; i < 4; i++ {
		id, err := n.Issue()
		if err != nil {
			t.Fatalf("Issue: %v", err)
		}
		got = append(got, id)
	}

	// Restart the node: it must resume from the durable cursor, not reissue.
	n2 := NewNode("n1", store, alloc)
	if err := n2.Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
	for {
		id, err := n2.Issue()
		if errors.Is(err, ErrExhausted) {
			break
		}
		if err != nil {
			t.Fatalf("Issue after restart: %v", err)
		}
		got = append(got, id)
	}

	if len(got) != 10 {
		t.Fatalf("expected 10 ids, got %d: %v", len(got), got)
	}
	for i, id := range got {
		if id != int64(i+1) {
			t.Fatalf("id sequence broken at %d: %v", i, got)
		}
	}
}

func TestTransferClosesOldGenerationFirst(t *testing.T) {
	store := newFileStorage(t)
	alloc, err := OpenAllocator(store)
	if err != nil {
		t.Fatalf("OpenAllocator: %v", err)
	}

	n1 := NewNode("n1", store, alloc)
	if err := n1.Acquire(10); err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	for i := 0; i < 3; i++ {
		if _, err := n1.Issue(); err != nil {
			t.Fatalf("Issue: %v", err)
		}
	}

	lease, err := n1.HandOver("n2")
	if err != nil {
		t.Fatalf("HandOver: %v", err)
	}
	if lease.Start != 4 || lease.End != 10 || lease.Generation != 2 {
		t.Fatalf("transferred lease wrong: %+v", lease)
	}

	// The old owner is fenced immediately...
	if _, err := n1.Issue(); !errors.Is(err, ErrNoLease) {
		t.Fatalf("old owner Issue after handover: got %v, want ErrNoLease", err)
	}
	// ...and stays fenced even after a restart reloads its stale state file.
	n1b := NewNode("n1", store, alloc)
	if err := n1b.Load(); err != nil {
		t.Fatalf("Load stale owner: %v", err)
	}
	if _, err := n1b.Issue(); !errors.Is(err, ErrNoLease) {
		t.Fatalf("restarted stale owner Issue: got %v, want ErrNoLease", err)
	}
	if err := alloc.Validate(lease.RangeID, 1); !errors.Is(err, ErrFenced) {
		t.Fatalf("Validate old generation: got %v, want ErrFenced", err)
	}

	// The new owner continues the unconsumed tail.
	n2 := NewNode("n2", store, alloc)
	if err := n2.Attach(lease); err != nil {
		t.Fatalf("Attach: %v", err)
	}
	for want := int64(4); want <= 10; want++ {
		id, err := n2.Issue()
		if err != nil {
			t.Fatalf("new owner Issue: %v", err)
		}
		if id != want {
			t.Fatalf("new owner issued %d, want %d", id, want)
		}
	}

	// Transferring an exhausted tail fails instead of reissuing integers.
	if _, err := n2.HandOver("n3"); !errors.Is(err, ErrRangeExhausted) {
		t.Fatalf("HandOver exhausted range: got %v, want ErrRangeExhausted", err)
	}
}

func TestCrashAfterPersistKeepsCursor(t *testing.T) {
	store := NewCrashStorage()
	alloc, err := OpenAllocator(store)
	if err != nil {
		t.Fatalf("OpenAllocator: %v", err)
	}
	n := NewNode("n1", store, alloc)
	if err := n.Acquire(5); err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	for i := 0; i < 2; i++ {
		if _, err := n.Issue(); err != nil {
			t.Fatalf("Issue: %v", err)
		}
	}

	// Power loss: everything synced so far survives; instances are dead.
	store.Crash()
	if _, err := n.Issue(); !errors.Is(err, ErrCrashed) {
		t.Fatalf("Issue on dead instance: got %v, want ErrCrashed", err)
	}

	alloc2, err := OpenAllocator(store)
	if err != nil {
		t.Fatalf("reopen allocator: %v", err)
	}
	n2 := NewNode("n1", store, alloc2)
	if err := n2.Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
	for want := int64(3); want <= 5; want++ {
		id, err := n2.Issue()
		if err != nil {
			t.Fatalf("Issue after crash: %v", err)
		}
		if id != want {
			t.Fatalf("after crash issued %d, want %d (reissue!)", id, want)
		}
	}
	if _, err := n2.Issue(); !errors.Is(err, ErrExhausted) {
		t.Fatalf("Issue past end: got %v, want ErrExhausted", err)
	}
}

func TestFailedPersistDoesNotConsumeID(t *testing.T) {
	store := NewCrashStorage()
	alloc, err := OpenAllocator(store)
	if err != nil {
		t.Fatalf("OpenAllocator: %v", err)
	}
	n := NewNode("n1", store, alloc)
	if err := n.Acquire(3); err != nil {
		t.Fatalf("Acquire: %v", err)
	}

	store.ArmFailWrites(1)
	if _, err := n.Issue(); err == nil {
		t.Fatal("Issue with failing disk should return an error")
	}
	// The id was not consumed: the retry hands out the same integer once.
	id, err := n.Issue()
	if err != nil {
		t.Fatalf("Issue retry: %v", err)
	}
	if id != 1 {
		t.Fatalf("retry issued %d, want 1", id)
	}
	id, err = n.Issue()
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if id != 2 {
		t.Fatalf("issued %d, want 2", id)
	}
}

func TestConcurrentIssueIsUnique(t *testing.T) {
	store := NewCrashStorage()
	alloc, err := OpenAllocator(store)
	if err != nil {
		t.Fatalf("OpenAllocator: %v", err)
	}
	n := NewNode("solo", store, alloc)
	const total = 8000
	if err := n.Acquire(total); err != nil {
		t.Fatalf("Acquire: %v", err)
	}

	var wg sync.WaitGroup
	var mu sync.Mutex
	seen := make(map[int64]struct{}, total)
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < total/8; i++ {
				id, err := n.Issue()
				if err != nil {
					t.Errorf("Issue: %v", err)
					return
				}
				mu.Lock()
				if _, dup := seen[id]; dup {
					t.Errorf("duplicate id %d", id)
				}
				seen[id] = struct{}{}
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if len(seen) != total {
		t.Fatalf("issued %d unique ids, want %d", len(seen), total)
	}
}
