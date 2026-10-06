package sampler

import (
	"errors"
	"fmt"
	"sync"
	"testing"
)

func collectSeqs(t *testing.T, b *Buffer) []int64 {
	t.Helper()
	var seqs []int64
	b.Range(func(seq int64, _ any) bool {
		seqs = append(seqs, seq)
		return true
	})
	return seqs
}

func equalSeqs(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// Wraparound: after more writes than capacity, only the newest N items
// remain, in order, and evicted items are gone.
func TestWraparound(t *testing.T) {
	b := New(3)
	for i := 1; i <= 8; i++ {
		if err := b.Append(i * 10); err != nil {
			t.Fatalf("Append(%d): %v", i, err)
		}
	}
	if got, want := b.Len(), 3; got != want {
		t.Fatalf("Len = %d, want %d", got, want)
	}
	if got, want := collectSeqs(t, b), []int64{6, 7, 8}; !equalSeqs(got, want) {
		t.Fatalf("seqs = %v, want %v", got, want)
	}
	for seq := int64(6); seq <= 8; seq++ {
		v, err := b.Get(seq)
		if err != nil {
			t.Fatalf("Get(%d): %v", seq, err)
		}
		if v != int(seq*10) {
			t.Fatalf("Get(%d) = %v, want %d", seq, v, seq*10)
		}
	}
	if _, err := b.Get(5); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get(5) = %v, want ErrNotFound", err)
	}
	// Ordinal indexing follows logical order after wraparound.
	seq, v, err := b.At(0)
	if err != nil || seq != 6 || v != 60 {
		t.Fatalf("At(0) = (%d, %v, %v), want (6, 60, nil)", seq, v, err)
	}
}

// A pinned oldest item must reject overwriting writes instead of being dropped.
func TestSnapshotRejectsOverwrite(t *testing.T) {
	b := New(2)
	mustAppend(t, b, "a") // seq 1
	mustAppend(t, b, "b") // seq 2

	snap := b.Snapshot()
	if err := b.Append("c"); !errors.Is(err, ErrCapacity) {
		t.Fatalf("Append while pinned = %v, want ErrCapacity", err)
	}
	// Nothing was lost.
	if got, want := collectSeqs(t, b), []int64{1, 2}; !equalSeqs(got, want) {
		t.Fatalf("seqs = %v, want %v", got, want)
	}
	// Pinned items stay readable through the snapshot.
	for i, want := range []string{"a", "b"} {
		_, v, err := snap.At(i)
		if err != nil || v != want {
			t.Fatalf("snap.At(%d) = (%v, %v), want (%q, nil)", i, v, err, want)
		}
	}
	snap.Release()
	if _, err := snap.Get(1); !errors.Is(err, ErrReleased) {
		t.Fatalf("Get after Release = %v, want ErrReleased", err)
	}
	// After release, eviction works again.
	mustAppend(t, b, "c")
	if got, want := collectSeqs(t, b), []int64{2, 3}; !equalSeqs(got, want) {
		t.Fatalf("seqs = %v, want %v", got, want)
	}
}

// Partial pinning: only the pinned prefix blocks writes; once unpinned items
// are evicted the buffer fills up against the pinned ones.
func TestPartialPin(t *testing.T) {
	b := New(3)
	mustAppend(t, b, 1)
	mustAppend(t, b, 2)
	snap := b.Snapshot() // pins seqs 1, 2
	mustAppend(t, b, 3)  // buffer now {1, 2, 3}, 1 and 2 pinned
	if err := b.Append(4); !errors.Is(err, ErrCapacity) {
		t.Fatalf("Append = %v, want ErrCapacity", err)
	}
	snap.Release()
	mustAppend(t, b, 4) // evicts 1
	mustAppend(t, b, 5) // evicts 2
	if got, want := collectSeqs(t, b), []int64{3, 4, 5}; !equalSeqs(got, want) {
		t.Fatalf("seqs = %v, want %v", got, want)
	}
}

// Sequence gaps must not affect indexing or lookup.
func TestSequenceGaps(t *testing.T) {
	b := New(4)
	for _, seq := range []int64{10, 11, 25, 26, 27, 100} {
		if err := b.AppendAt(seq, seq*2); err != nil {
			t.Fatalf("AppendAt(%d): %v", seq, err)
		}
	}
	// Capacity 4, so 10 and 11 were evicted.
	if got, want := collectSeqs(t, b), []int64{25, 26, 27, 100}; !equalSeqs(got, want) {
		t.Fatalf("seqs = %v, want %v", got, want)
	}
	for _, seq := range []int64{25, 26, 27, 100} {
		v, err := b.Get(seq)
		if err != nil || v != seq*2 {
			t.Fatalf("Get(%d) = (%v, %v), want (%d, nil)", seq, v, err, seq*2)
		}
	}
	if _, err := b.Get(50); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get(50) = %v, want ErrNotFound", err)
	}
	// Ordinal indexing is dense even though sequence numbers are sparse.
	for i, want := range []int64{25, 26, 27, 100} {
		seq, _, err := b.At(i)
		if err != nil || seq != want {
			t.Fatalf("At(%d) = (%d, %v), want (%d, nil)", i, seq, err, want)
		}
	}
	if err := b.AppendAt(100, 0); !errors.Is(err, ErrStaleSeq) {
		t.Fatalf("AppendAt(100) = %v, want ErrStaleSeq", err)
	}
	if err := b.AppendAt(50, 0); !errors.Is(err, ErrStaleSeq) {
		t.Fatalf("AppendAt(50) = %v, want ErrStaleSeq", err)
	}
}

// Interleave snapshot acquisition with writes across a wraparound boundary.
func TestSnapshotWriteInterleaving(t *testing.T) {
	b := New(3)
	mustAppend(t, b, "v1")
	snap1 := b.Snapshot() // pins 1
	mustAppend(t, b, "v2")
	mustAppend(t, b, "v3") // buffer full: {1, 2, 3}
	snap2 := b.Snapshot()  // pins 1, 2, 3

	if err := b.Append("v4"); !errors.Is(err, ErrCapacity) {
		t.Fatalf("Append = %v, want ErrCapacity (seq 1 pinned)", err)
	}
	// While held, snapshots still read their pinned items.
	if v, err := snap1.Get(1); err != nil || v != "v1" {
		t.Fatalf("snap1.Get(1) = (%v, %v), want (v1, nil)", v, err)
	}
	if v, err := snap2.Get(3); err != nil || v != "v3" {
		t.Fatalf("snap2.Get(3) = (%v, %v), want (v3, nil)", v, err)
	}
	snap1.Release() // seq 1 still pinned by snap2
	if err := b.Append("v4"); !errors.Is(err, ErrCapacity) {
		t.Fatalf("Append = %v, want ErrCapacity (seq 1 still pinned)", err)
	}
	snap2.Release()
	mustAppend(t, b, "v4") // evicts 1, wraps around

	// Old snapshots read old items; the new snapshot reads new items.
	if v, err := snap2.Get(1); !errors.Is(err, ErrReleased) {
		// snap2 is released, so this must fail.
		t.Fatalf("snap2.Get(1) = (%v, %v), want ErrReleased", v, err)
	}
	snap3 := b.Snapshot()
	if got, want := snap3.Seqs(), []int64{2, 3, 4}; !equalSeqs(got, want) {
		t.Fatalf("snap3 seqs = %v, want %v", got, want)
	}
	if _, err := snap3.Get(1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("snap3.Get(1) = %v, want ErrNotFound", err)
	}
	snap3.Release()
}

// Barrier test: writers and snapshotters start together and interleave
// concurrently. Values equal their sequence numbers, so any slot corruption
// from wraparound races is detected by snapshot reads. Run with -race.
func TestBarrierConcurrentInterleave(t *testing.T) {
	const (
		writers      = 4
		writesEach   = 200
		snapshotters = 3
		snapsEach    = 100
	)
	b := New(16)
	barrier := make(chan struct{})
	var wg sync.WaitGroup
	errs := make(chan error, writers*writesEach+snapshotters*snapsEach)

	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-barrier
			for i := 0; i < writesEach; i++ {
				for {
					b.mu.RLock()
					next := b.lastSeq + 1
					b.mu.RUnlock()
					err := b.AppendAt(next, next) // value mirrors its seq
					if errors.Is(err, ErrStaleSeq) {
						continue // another writer won the seq; retry
					}
					if err != nil && !errors.Is(err, ErrCapacity) {
						errs <- fmt.Errorf("AppendAt: %w", err)
					}
					break // ErrCapacity is legal while snapshots pin items
				}
			}
		}()
	}
	for s := 0; s < snapshotters; s++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-barrier
			for i := 0; i < snapsEach; i++ {
				snap := b.Snapshot()
				var readErr error
				snap.Range(func(seq int64, v any) bool {
					if v != seq {
						readErr = fmt.Errorf("snapshot read seq=%d value=%v", seq, v)
						return false
					}
					return true
				})
				if readErr != nil {
					errs <- readErr
				}
				snap.Release()
			}
		}()
	}

	close(barrier) // release all goroutines at once
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	// Every retained item must satisfy value == seq and be strictly ordered.
	var prev int64
	b.Range(func(seq int64, v any) bool {
		if v != seq {
			t.Errorf("buffer seq=%d holds value=%v", seq, v)
		}
		if seq <= prev {
			t.Errorf("seqs not increasing: %d after %d", seq, prev)
		}
		prev = seq
		return true
	})
}

// A failed (rejected) write must not consume a sequence number or corrupt state.
func TestRejectedWriteKeepsState(t *testing.T) {
	b := New(1)
	mustAppend(t, b, "x")
	snap := b.Snapshot()
	if err := b.Append("y"); !errors.Is(err, ErrCapacity) {
		t.Fatalf("Append = %v, want ErrCapacity", err)
	}
	snap.Release()
	mustAppend(t, b, "y") // must get seq 2, not 3
	if got, want := collectSeqs(t, b), []int64{2}; !equalSeqs(got, want) {
		t.Fatalf("seqs = %v, want %v", got, want)
	}
}

func mustAppend(t *testing.T, b *Buffer, v any) {
	t.Helper()
	if err := b.Append(v); err != nil {
		t.Fatalf("Append(%v): %v", v, err)
	}
}
