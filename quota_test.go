package leasequota

import (
	"errors"
	"math/rand"
	"sync"
	"sync/atomic"
	"testing"
)

func assertCounters(t *testing.T, q *Quota, wantUsed, wantReserved int64) {
	t.Helper()
	used, reserved, total := q.Snapshot()
	if used != wantUsed || reserved != wantReserved {
		t.Fatalf("quota counters = used %d, reserved %d; want used %d, reserved %d",
			used, reserved, wantUsed, wantReserved)
	}
	if used+reserved > total {
		t.Fatalf("invariant violated: used %d + reserved %d > total %d", used, reserved, total)
	}
}

func TestReserveCommitExact(t *testing.T) {
	q := NewQuota(100)
	l, err := q.Reserve(100)
	if err != nil {
		t.Fatalf("Reserve: %v", err)
	}
	assertCounters(t, q, 0, 100)
	if err := l.Commit(100); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	assertCounters(t, q, 100, 0)
	if got := q.Available(); got != 0 {
		t.Fatalf("Available = %d, want 0", got)
	}
}

func TestCommitShortWriteReturnsReservation(t *testing.T) {
	q := NewQuota(100)
	l, err := q.Reserve(100)
	if err != nil {
		t.Fatalf("Reserve: %v", err)
	}
	// Only 30 of the 100 reserved bytes were actually written.
	if err := l.Commit(30); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	assertCounters(t, q, 30, 0)
	if got := q.Available(); got != 70 {
		t.Fatalf("Available = %d, want 70", got)
	}
}

func TestReleaseReturnsReservation(t *testing.T) {
	q := NewQuota(100)
	l, err := q.Reserve(60)
	if err != nil {
		t.Fatalf("Reserve: %v", err)
	}
	if err := l.Release(); err != nil {
		t.Fatalf("Release: %v", err)
	}
	assertCounters(t, q, 0, 0)
	if got := l.Outstanding(); got != 0 {
		t.Fatalf("Outstanding = %d, want 0", got)
	}
}

func TestReserveBeyondTotalFails(t *testing.T) {
	q := NewQuota(100)
	if _, err := q.Reserve(60); err != nil {
		t.Fatalf("Reserve(60): %v", err)
	}
	_, err := q.Reserve(50)
	if !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("Reserve(50) error = %v, want ErrQuotaExceeded", err)
	}
	assertCounters(t, q, 0, 60)
	if _, err := q.Reserve(-1); err == nil {
		t.Fatal("Reserve(-1) succeeded, want error")
	}
}

func TestCommitBeyondOutstandingFails(t *testing.T) {
	q := NewQuota(100)
	l, err := q.Reserve(50)
	if err != nil {
		t.Fatalf("Reserve: %v", err)
	}
	if err := l.Commit(60); err == nil {
		t.Fatal("Commit(60) with 50 outstanding succeeded, want error")
	}
	// The failed commit must not have closed or drained the lease.
	if got := l.Outstanding(); got != 50 {
		t.Fatalf("Outstanding = %d, want 50", got)
	}
	assertCounters(t, q, 0, 50)
	if err := l.Release(); err != nil {
		t.Fatalf("Release: %v", err)
	}
	assertCounters(t, q, 0, 0)
}

func TestCommittedLeaseCannotBeCancelled(t *testing.T) {
	q := NewQuota(100)
	l, err := q.Reserve(40)
	if err != nil {
		t.Fatalf("Reserve: %v", err)
	}
	if err := l.Commit(40); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if err := l.Release(); err == nil {
		t.Fatal("Release after Commit succeeded, want error")
	}
	if err := l.Commit(40); err == nil {
		t.Fatal("second Commit succeeded, want error")
	}
	if err := l.Grow(1); err == nil {
		t.Fatal("Grow after Commit succeeded, want error")
	}
	// Quota must be untouched by all of the failed operations above.
	assertCounters(t, q, 40, 0)
}

func TestReleasedLeaseCannotBeReused(t *testing.T) {
	q := NewQuota(100)
	l, err := q.Reserve(40)
	if err != nil {
		t.Fatalf("Reserve: %v", err)
	}
	if err := l.Release(); err != nil {
		t.Fatalf("Release: %v", err)
	}
	if err := l.Release(); err == nil {
		t.Fatal("second Release succeeded, want error")
	}
	if err := l.Commit(0); err == nil {
		t.Fatal("Commit after Release succeeded, want error")
	}
	assertCounters(t, q, 0, 0)
}

func TestLeaseGrow(t *testing.T) {
	q := NewQuota(100)
	l, err := q.Reserve(40)
	if err != nil {
		t.Fatalf("Reserve: %v", err)
	}
	if err := l.Grow(30); err != nil {
		t.Fatalf("Grow(30): %v", err)
	}
	if got := l.Outstanding(); got != 70 {
		t.Fatalf("Outstanding = %d, want 70", got)
	}
	assertCounters(t, q, 0, 70)
	if err := l.Grow(50); !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("Grow(50) error = %v, want ErrQuotaExceeded", err)
	}
	// Failed growth leaves the lease unchanged.
	if got := l.Outstanding(); got != 70 {
		t.Fatalf("Outstanding after failed Grow = %d, want 70", got)
	}
	if err := l.Commit(70); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	assertCounters(t, q, 70, 0)
}

func TestFree(t *testing.T) {
	q := NewQuota(100)
	l, err := q.Reserve(80)
	if err != nil {
		t.Fatalf("Reserve: %v", err)
	}
	if err := l.Commit(80); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if err := q.Free(50); err != nil {
		t.Fatalf("Free(50): %v", err)
	}
	assertCounters(t, q, 30, 0)
	if err := q.Free(31); err == nil {
		t.Fatal("Free(31) with 30 used succeeded, want error")
	}
	if err := q.Free(-1); err == nil {
		t.Fatal("Free(-1) succeeded, want error")
	}
	assertCounters(t, q, 30, 0)
}

// TestConcurrentInvariant hammers the quota from many goroutines with random
// reserves, grows, short/exact commits and releases, checking the invariant
// used+reserved <= total throughout and the exact final accounting.
func TestConcurrentInvariant(t *testing.T) {
	const total = 1 << 20
	q := NewQuota(total)

	var committedBytes atomic.Int64
	var samplerWG, workerWG sync.WaitGroup
	stop := make(chan struct{})

	// Invariant sampler.
	samplerWG.Add(1)
	go func() {
		defer samplerWG.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			used, reserved, tot := q.Snapshot()
			if used < 0 || reserved < 0 || used+reserved > tot {
				t.Errorf("invariant violated: used=%d reserved=%d total=%d", used, reserved, tot)
				return
			}
		}
	}()

	for w := 0; w < 16; w++ {
		workerWG.Add(1)
		go func(seed int64) {
			defer workerWG.Done()
			rng := rand.New(rand.NewSource(seed))
			for i := 0; i < 300; i++ {
				l, err := q.Reserve(int64(rng.Intn(4097)))
				if errors.Is(err, ErrQuotaExceeded) {
					continue
				}
				if err != nil {
					t.Errorf("Reserve: %v", err)
					return
				}
				if rng.Intn(4) == 0 {
					// Occasionally grow; failure must leave things intact.
					_ = l.Grow(int64(rng.Intn(1025)))
				}
				if rng.Intn(3) == 0 {
					if err := l.Release(); err != nil {
						t.Errorf("Release: %v", err)
						return
					}
					continue
				}
				// Commit a random short-or-exact amount.
				var n int64
				if out := l.Outstanding(); out > 0 {
					n = rng.Int63n(out + 1)
				}
				if err := l.Commit(n); err != nil {
					t.Errorf("Commit(%d): %v", n, err)
					return
				}
				committedBytes.Add(n)
			}
		}(int64(w) + 1)
	}

	workerWG.Wait()
	close(stop)
	samplerWG.Wait()

	used, reserved, _ := q.Snapshot()
	if reserved != 0 {
		t.Fatalf("reserved = %d after all leases closed, want 0", reserved)
	}
	if used != committedBytes.Load() {
		t.Fatalf("used = %d, want %d (sum of commits)", used, committedBytes.Load())
	}
}
