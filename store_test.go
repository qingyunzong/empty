package sampler

import (
	"errors"
	"fmt"
	"sync"
	"testing"
)

// barrier is a reusable cyclic barrier used to deterministically interleave
// goroutines in the concurrency tests.
type barrier struct {
	mu    sync.Mutex
	cond  sync.Cond
	n     int
	count int
	gen   int
}

func newBarrier(n int) *barrier {
	b := &barrier{n: n}
	b.cond.L = &b.mu
	return b
}

func (b *barrier) await() {
	b.mu.Lock()
	gen := b.gen
	b.count++
	if b.count == b.n {
		b.count = 0
		b.gen++
		b.cond.Broadcast()
	} else {
		for gen == b.gen {
			b.cond.Wait()
		}
	}
	b.mu.Unlock()
}

func mustPut(t *testing.T, s *Store, seq uint64, value any) {
	t.Helper()
	if err := s.Put(seq, value); err != nil {
		t.Fatalf("Put(%d): unexpected error: %v", seq, err)
	}
}

func mustGet(t *testing.T, s *Store, seq uint64, want any) {
	t.Helper()
	got, ok := s.Get(seq)
	if !ok {
		t.Fatalf("Get(%d): not found", seq)
	}
	if got != want {
		t.Fatalf("Get(%d) = %v, want %v", seq, got, want)
	}
}

func mustMissing(t *testing.T, s *Store, seq uint64) {
	t.Helper()
	if _, ok := s.Get(seq); ok {
		t.Fatalf("Get(%d): expected miss", seq)
	}
}

func TestPutGetAndEviction(t *testing.T) {
	s := New(3)
	for seq := uint64(1); seq <= 5; seq++ {
		mustPut(t, s, seq, int(seq)*10)
	}
	if s.Len() != 3 {
		t.Fatalf("Len = %d, want 3", s.Len())
	}
	mustMissing(t, s, 1)
	mustMissing(t, s, 2)
	mustGet(t, s, 3, 30)
	mustGet(t, s, 4, 40)
	mustGet(t, s, 5, 50)
	if oldest, ok := s.Oldest(); !ok || oldest != 3 {
		t.Fatalf("Oldest = %d, %v; want 3, true", oldest, ok)
	}
	if latest, ok := s.Latest(); !ok || latest != 5 {
		t.Fatalf("Latest = %d, %v; want 5, true", latest, ok)
	}
}

func TestSequenceGapsDoNotAffectIndexing(t *testing.T) {
	s := New(4)
	for _, seq := range []uint64{2, 7, 9, 42} {
		mustPut(t, s, seq, fmt.Sprintf("v%d", seq))
	}
	for _, seq := range []uint64{2, 7, 9, 42} {
		mustGet(t, s, seq, fmt.Sprintf("v%d", seq))
	}
	// Sequences that fall into gaps were never written.
	for _, seq := range []uint64{1, 3, 8, 10, 41, 43} {
		mustMissing(t, s, seq)
	}
	// A gapped write past capacity evicts the oldest, gap or not.
	mustPut(t, s, 100, "v100")
	mustMissing(t, s, 2)
	mustGet(t, s, 7, "v7")
	mustGet(t, s, 100, "v100")
}

func TestSeqRegressionRejected(t *testing.T) {
	s := New(2)
	mustPut(t, s, 5, "a")
	if err := s.Put(5, "b"); !errors.Is(err, ErrSeqRegression) {
		t.Fatalf("Put(5) err = %v, want ErrSeqRegression", err)
	}
	if err := s.Put(3, "c"); !errors.Is(err, ErrSeqRegression) {
		t.Fatalf("Put(3) err = %v, want ErrSeqRegression", err)
	}
	mustGet(t, s, 5, "a")
}

func TestWraparound(t *testing.T) {
	s := New(4)
	const total = 100
	for seq := uint64(1); seq <= total; seq++ {
		mustPut(t, s, seq, int(seq))
	}
	if s.Len() != 4 {
		t.Fatalf("Len = %d, want 4", s.Len())
	}
	for seq := uint64(total - 3); seq <= total; seq++ {
		mustGet(t, s, seq, int(seq))
	}
	mustMissing(t, s, total-4)
	if oldest, _ := s.Oldest(); oldest != total-3 {
		t.Fatalf("Oldest = %d, want %d", oldest, total-3)
	}
	// Keep cycling to exercise repeated head wraparound.
	for seq := uint64(total + 1); seq <= total+8; seq++ {
		mustPut(t, s, seq, int(seq))
	}
	for seq := uint64(total + 5); seq <= total+8; seq++ {
		mustGet(t, s, seq, int(seq))
	}
	mustMissing(t, s, total+4)
}

func TestSnapshotPinsOldestAndRejectsOverwrite(t *testing.T) {
	s := New(3)
	mustPut(t, s, 1, "a")
	mustPut(t, s, 2, "b")
	mustPut(t, s, 3, "c")

	snap, ok := s.Acquire()
	if !ok {
		t.Fatal("Acquire: not ok")
	}
	if snap.Pin() != 1 {
		t.Fatalf("Pin = %d, want 1", snap.Pin())
	}
	// Capacity is exhausted and the oldest item is pinned: reject, keep data.
	if err := s.Put(4, "d"); !errors.Is(err, ErrFull) {
		t.Fatalf("Put(4) err = %v, want ErrFull", err)
	}
	mustGet(t, s, 1, "a") // old data preserved
	if s.Len() != 3 {
		t.Fatalf("Len = %d, want 3", s.Len())
	}

	snap.Release()
	if !snap.Released() {
		t.Fatal("Released = false after Release")
	}
	mustPut(t, s, 4, "d") // now evicts seq 1
	mustMissing(t, s, 1)
	mustGet(t, s, 4, "d")
}

func TestSnapshotReadsOldItemsUntilRelease(t *testing.T) {
	s := New(4)
	mustPut(t, s, 1, "a")
	mustPut(t, s, 2, "b")
	mustPut(t, s, 3, "c")

	snap, _ := s.Acquire()
	mustPut(t, s, 4, "d") // room left: allowed
	if err := s.Put(5, "e"); !errors.Is(err, ErrFull) {
		t.Fatalf("Put(5) err = %v, want ErrFull", err)
	}

	items := snap.Items()
	if len(items) != 4 {
		t.Fatalf("snapshot Items len = %d, want 4", len(items))
	}
	for i, want := range []uint64{1, 2, 3, 4} {
		if items[i].Seq != want {
			t.Fatalf("items[%d].Seq = %d, want %d", i, items[i].Seq, want)
		}
	}
	if _, ok := snap.Get(2); !ok {
		t.Fatal("snapshot Get(2): not found while pinned")
	}

	snap.Release()
	mustPut(t, s, 5, "e")
	mustMissing(t, s, 1)
}

func TestAcquireFromAllowsEvictingOlderThanPin(t *testing.T) {
	s := New(4)
	for seq := uint64(1); seq <= 4; seq++ {
		mustPut(t, s, seq, int(seq))
	}
	snap, ok := s.AcquireFrom(3)
	if !ok {
		t.Fatal("AcquireFrom(3): not ok")
	}
	mustPut(t, s, 5, 5) // evicts 1 (older than pin)
	mustPut(t, s, 6, 6) // evicts 2 (older than pin)
	if err := s.Put(7, 7); !errors.Is(err, ErrFull) {
		t.Fatalf("Put(7) err = %v, want ErrFull", err) // 3 is pinned
	}
	mustMissing(t, s, 1)
	mustMissing(t, s, 2)
	for seq := uint64(3); seq <= 6; seq++ {
		if _, ok := snap.Get(seq); !ok {
			t.Fatalf("snapshot Get(%d): not found", seq)
		}
	}
	snap.Release()
	snap.Release() // idempotent
	mustPut(t, s, 7, 7)
	mustMissing(t, s, 3)
}

func TestAcquireFromMissingSeq(t *testing.T) {
	s := New(2)
	mustPut(t, s, 10, "x")
	if _, ok := s.AcquireFrom(99); ok {
		t.Fatal("AcquireFrom(99): expected not ok")
	}
	if _, ok := s.AcquireFrom(5); ok {
		t.Fatal("AcquireFrom(5): expected not ok for gap")
	}
}

func TestAcquireOnEmptyStore(t *testing.T) {
	s := New(2)
	if _, ok := s.Acquire(); ok {
		t.Fatal("Acquire on empty store: expected not ok")
	}
	if _, ok := s.Oldest(); ok {
		t.Fatal("Oldest on empty store: expected not ok")
	}
	if _, ok := s.Latest(); ok {
		t.Fatal("Latest on empty store: expected not ok")
	}
}

func TestMultipleSnapshotsMinPinGoverns(t *testing.T) {
	s := New(3)
	for seq := uint64(1); seq <= 3; seq++ {
		mustPut(t, s, seq, int(seq))
	}
	snap1, _ := s.Acquire()      // pins 1
	snap2, _ := s.AcquireFrom(2) // pins 2
	snap3, _ := s.AcquireFrom(2) // pins 2 again

	snap1.Release()
	// 1 is unpinned now, but 2 is still pinned twice.
	mustPut(t, s, 4, 4) // evicts 1
	if err := s.Put(5, 5); !errors.Is(err, ErrFull) {
		t.Fatalf("Put(5) err = %v, want ErrFull", err)
	}
	snap2.Release()
	if err := s.Put(5, 5); !errors.Is(err, ErrFull) {
		t.Fatalf("Put(5) after one release err = %v, want ErrFull", err)
	}
	snap3.Release()
	mustPut(t, s, 5, 5) // evicts 2
	mustMissing(t, s, 2)
	mustGet(t, s, 5, 5)
}

// TestBarrierInterleavedSnapshotAndWrites uses a cyclic barrier to
// deterministically interleave snapshot acquisition, wraparound writes and
// overwrite rejection across two goroutines.
func TestBarrierInterleavedSnapshotAndWrites(t *testing.T) {
	s := New(4)
	for seq := uint64(1); seq <= 3; seq++ {
		mustPut(t, s, seq, fmt.Sprintf("v%d", seq))
	}

	b := newBarrier(2)
	var wg sync.WaitGroup
	wg.Add(1)

	go func() {
		defer wg.Done()
		snap, ok := s.Acquire() // pins seq 1
		if !ok {
			t.Error("Acquire: not ok")
			return
		}
		b.await() // phase 1: snapshot acquired, writer may proceed
		b.await() // phase 2: writer filled buffer and hit rejection
		// Everything from the pin onward must still be readable.
		for seq := uint64(1); seq <= 4; seq++ {
			got, ok := snap.Get(seq)
			if !ok {
				t.Errorf("snapshot Get(%d): not found", seq)
				continue
			}
			if want := fmt.Sprintf("v%d", seq); got != want {
				t.Errorf("snapshot Get(%d) = %v, want %v", seq, got, want)
			}
		}
		snap.Release()
		b.await() // phase 3: released, writer may evict
	}()

	b.await() // wait for the snapshot to pin seq 1
	mustPut(t, s, 4, "v4")
	if err := s.Put(5, "v5"); !errors.Is(err, ErrFull) {
		t.Fatalf("Put(5) err = %v, want ErrFull", err)
	}
	mustGet(t, s, 1, "v1") // rejected overwrite must not drop old data
	b.await()              // let the reader verify pinned items
	b.await()              // wait for Release
	mustPut(t, s, 5, "v5") // wraparound write now evicts seq 1
	mustMissing(t, s, 1)
	mustGet(t, s, 5, "v5")
	wg.Wait()
}

// TestBarrierWraparoundCycles drives many barrier-synchronized write/read
// cycles so the ring head wraps repeatedly while a reader verifies contents.
func TestBarrierWraparoundCycles(t *testing.T) {
	const (
		cap    = 8
		cycles = 50
	)
	s := New(cap)
	b := newBarrier(2)
	var wg sync.WaitGroup
	wg.Add(1)

	go func() {
		defer wg.Done()
		for cycle := 0; cycle < cycles; cycle++ {
			b.await() // reader observes, then writer refills
			base := uint64(cycle * cap)
			for i := uint64(1); i <= cap; i++ {
				if err := s.Put(base+i, base+i); err != nil {
					t.Errorf("cycle %d Put(%d): %v", cycle, base+i, err)
					return
				}
			}
			b.await()
		}
	}()

	for cycle := 0; cycle < cycles; cycle++ {
		base := uint64(cycle * cap)
		if cycle > 0 {
			// Previous cycle filled the buffer exactly: verify it fully.
			prev := uint64((cycle - 1) * cap)
			for i := uint64(1); i <= cap; i++ {
				mustGet(t, s, prev+i, prev+i)
			}
			if oldest, _ := s.Oldest(); oldest != prev+1 {
				t.Fatalf("cycle %d: Oldest = %d, want %d", cycle, oldest, prev+1)
			}
		}
		b.await() // let the writer refill
		b.await() // wait for the refill to complete
		_ = base
	}
	wg.Wait()
	for i := uint64(1); i <= cap; i++ {
		seq := uint64((cycles-1)*cap) + i
		mustGet(t, s, seq, seq)
	}
}

// TestConcurrentStress hammers the store from many goroutines to surface
// data races (run with -race) and invalid states.
func TestConcurrentStress(t *testing.T) {
	s := New(16)
	var wg sync.WaitGroup
	for g := 0; g < 4; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := uint64(1); i <= 500; i++ {
				seq := uint64(g)*1000000 + i
				// Concurrent writers race past each other's sequence ranges,
				// so ErrSeqRegression and ErrFull are both expected.
				if err := s.Put(seq, seq); err != nil &&
					!errors.Is(err, ErrFull) && !errors.Is(err, ErrSeqRegression) {
					t.Errorf("Put(%d): %v", seq, err)
					return
				}
				if snap, ok := s.Acquire(); ok {
					_, _ = snap.Get(snap.Pin())
					_ = snap.Items()
					snap.Release()
				}
			}
		}(g)
	}
	wg.Wait()
	if s.Len() > s.Capacity() {
		t.Fatalf("Len = %d exceeds capacity %d", s.Len(), s.Capacity())
	}
}
