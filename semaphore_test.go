package semaphore

import (
	"context"
	"sync"
	"testing"
	"time"
)

// waitGranted waits until f becomes true, failing the test after a timeout.
func waitFor(t *testing.T, what string, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if f() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// assertBlocked fails the test if ch receives within a short window.
func assertBlocked(t *testing.T, what string, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
		t.Fatalf("%s: expected to stay blocked, but proceeded", what)
	case <-time.After(50 * time.Millisecond):
	}
}

func acquireAsync(ctx context.Context, s *Semaphore, n int64) chan error {
	ch := make(chan error, 1)
	go func() { ch <- s.Acquire(ctx, n) }()
	return ch
}

func TestBasicAcquireRelease(t *testing.T) {
	s := New(3)
	if !s.TryAcquire(2) {
		t.Fatal("TryAcquire(2) failed on fresh semaphore")
	}
	if err := s.Acquire(context.Background(), 1); err != nil {
		t.Fatalf("Acquire(1) failed: %v", err)
	}
	if s.TryAcquire(1) {
		t.Fatal("TryAcquire succeeded with no tokens left")
	}
	if got := s.InUse(); got != 3 {
		t.Fatalf("InUse = %d, want 3", got)
	}
	s.Release(2)
	if got := s.InUse(); got != 1 {
		t.Fatalf("InUse = %d, want 1", got)
	}
	if !s.TryAcquire(2) {
		t.Fatal("TryAcquire(2) failed after release")
	}
	if err := s.CheckConservation(); err != nil {
		t.Fatal(err)
	}
}

func TestInvalidSizes(t *testing.T) {
	s := New(1)
	if err := s.Acquire(context.Background(), 0); err != ErrInvalidSize {
		t.Fatalf("Acquire(0) err = %v, want ErrInvalidSize", err)
	}
	if s.TryAcquire(-1) {
		t.Fatal("TryAcquire(-1) succeeded")
	}
}

func TestReleaseMoreThanHeldPanics(t *testing.T) {
	s := New(2)
	s.TryAcquire(1)
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic on over-release")
		}
	}()
	s.Release(2)
}

func TestFIFOOrder(t *testing.T) {
	s := New(1)
	if err := s.Acquire(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	const n = 5
	granted := make(chan int, n)
	for i := 0; i < n; i++ {
		i := i
		// Serialize enqueueing so queue order matches goroutine index.
		for {
			s.mu.Lock()
			queued := s.waiters.Len() == i
			s.mu.Unlock()
			if queued {
				break
			}
			time.Sleep(time.Millisecond)
		}
		go func() {
			if err := s.Acquire(context.Background(), 1); err != nil {
				t.Error(err)
			}
			granted <- i
		}()
	}
	waitFor(t, "waiters to queue", func() bool { return s.Waiters() == n })
	for want := 0; want < n; want++ {
		s.Release(1)
		got := <-granted
		if got != want {
			t.Fatalf("grant order: got waiter %d, want %d (FIFO violated)", got, want)
		}
	}
}

func TestStrictFIFONoSkipping(t *testing.T) {
	// Head waiter needs 2 tokens, the one behind needs 1. Releasing 1 token
	// must not skip the head.
	s := New(2)
	s.TryAcquire(2)
	big := acquireAsync(context.Background(), s, 2)
	waitFor(t, "big waiter queued", func() bool { return s.Waiters() == 1 })
	small := acquireAsync(context.Background(), s, 1)
	waitFor(t, "small waiter queued", func() bool { return s.Waiters() == 2 })

	s.Release(1) // only 1 free; head needs 2
	select {
	case err := <-small:
		t.Fatalf("small waiter skipped oversized head, err=%v", err)
	case <-time.After(50 * time.Millisecond):
	}
	s.Release(1) // now head fits
	if err := <-big; err != nil {
		t.Fatal(err)
	}
	s.Release(2) // big is done; frees room for the small waiter
	if err := <-small; err != nil {
		t.Fatal(err)
	}
}

func TestCancelHeadLeavesNoHole(t *testing.T) {
	s := New(2)
	s.TryAcquire(2)

	ctxA, cancelA := context.WithCancel(context.Background())
	a := acquireAsync(ctxA, s, 2)
	waitFor(t, "A queued", func() bool { return s.Waiters() == 1 })
	b := acquireAsync(context.Background(), s, 1)
	waitFor(t, "B queued", func() bool { return s.Waiters() == 2 })

	cancelA()
	if err := <-a; err != context.Canceled {
		t.Fatalf("A err = %v, want context.Canceled", err)
	}
	waitFor(t, "A removed from queue", func() bool { return s.Waiters() == 1 })

	// One token freed: B (new head) must be granted immediately.
	s.Release(1)
	select {
	case err := <-b:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("B stuck behind cancelled head waiter (queue head hole)")
	}
	if got := s.InUse(); got != 2 { // 1 still held + 1 granted to B
		t.Fatalf("InUse = %d, want 2", got)
	}
	if err := s.CheckConservation(); err != nil {
		t.Fatal(err)
	}
}

func TestCancelMiddlePreservesOrder(t *testing.T) {
	s := New(1)
	s.TryAcquire(1)
	ctxB, cancelB := context.WithCancel(context.Background())
	a := acquireAsync(context.Background(), s, 1)
	waitFor(t, "A queued", func() bool { return s.Waiters() == 1 })
	b := acquireAsync(ctxB, s, 1)
	waitFor(t, "B queued", func() bool { return s.Waiters() == 2 })
	c := acquireAsync(context.Background(), s, 1)
	waitFor(t, "C queued", func() bool { return s.Waiters() == 3 })

	cancelB()
	if err := <-b; err != context.Canceled {
		t.Fatalf("B err = %v, want context.Canceled", err)
	}
	waitFor(t, "B removed", func() bool { return s.Waiters() == 2 })

	s.Release(1)
	if err := <-a; err != nil {
		t.Fatal(err)
	}
	s.Release(1)
	select {
	case err := <-c:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("C never granted after middle cancellation")
	}
}

func TestCancelConcurrentWithGrant(t *testing.T) {
	// Race cancellation against a grant: outcome must be exactly one of
	// "granted" or "cancelled", never a leaked token.
	for i := 0; i < 200; i++ {
		s := New(1)
		s.TryAcquire(1)
		ctx, cancel := context.WithCancel(context.Background())
		ch := acquireAsync(ctx, s, 1)
		waitFor(t, "waiter queued", func() bool { return s.Waiters() == 1 })
		go cancel()
		s.Release(1)
		err := <-ch
		switch err {
		case nil:
			s.Release(1) // grant won the race; hand the token back
		case context.Canceled:
		default:
			t.Fatalf("unexpected error %v", err)
		}
		waitFor(t, "queue drained", func() bool { return s.Waiters() == 0 })
		if got := s.InUse(); got != 0 { // every released token must be accounted for
			t.Fatalf("iteration %d: InUse = %d, want 0 (token leaked)", i, got)
		}
		if err := s.CheckConservation(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestShrinkStopsGrantsWithoutRevoking(t *testing.T) {
	s := New(10)
	if err := s.Acquire(context.Background(), 10); err != nil {
		t.Fatal(err)
	}
	s.Resize(5)

	// Over-committed: 10 in use, capacity 5. Existing tokens are not revoked.
	if got := s.InUse(); got != 10 {
		t.Fatalf("InUse = %d, want 10 (shrink must not revoke)", got)
	}
	if err := s.CheckConservation(); err != nil {
		t.Fatalf("transient over-commitment must be allowed: %v", err)
	}

	// No new grants while over-committed.
	if s.TryAcquire(1) {
		t.Fatal("TryAcquire succeeded while over-committed")
	}
	pending := acquireAsync(context.Background(), s, 1)
	waitFor(t, "waiter queued", func() bool { return s.Waiters() == 1 })
	granted := make(chan struct{})
	go func() {
		if err := <-pending; err == nil {
			close(granted)
		}
	}()

	// Release down to exactly the capacity: still no headroom.
	s.Release(5)
	assertBlocked(t, "waiter at inUse == capacity", granted)
	if err := s.CheckConservation(); err != nil {
		t.Fatal(err)
	}

	// One more release creates headroom; the waiter is granted.
	s.Release(1)
	select {
	case <-granted:
	case <-time.After(2 * time.Second):
		t.Fatal("waiter not granted after headroom restored")
	}
	if got := s.InUse(); got != 5 {
		t.Fatalf("InUse = %d, want 5", got)
	}
}

func TestShrinkNeverGrantsBeyondCapacity(t *testing.T) {
	// Interleave releases with a shrink; every grant must keep inUse <= capacity.
	s := New(4)
	s.TryAcquire(4)
	w1 := acquireAsync(context.Background(), s, 2)
	waitFor(t, "w1 queued", func() bool { return s.Waiters() == 1 })
	w1Granted := chanErr(w1)
	w2 := acquireAsync(context.Background(), s, 2)
	waitFor(t, "w2 queued", func() bool { return s.Waiters() == 2 })
	w2Granted := chanErr(w2)

	s.Resize(3)
	s.Release(2) // inUse 2, capacity 3: head needs 2, 2+2 > 3, must wait
	assertBlocked(t, "w1 would exceed shrunken capacity", w1Granted)
	s.Release(1) // inUse 1: head fits (1+2 <= 3)
	select {
	case <-w1Granted:
	case <-time.After(2 * time.Second):
		t.Fatal("w1 not granted once it fit")
	}
	if got := s.InUse(); got != 3 {
		t.Fatalf("InUse = %d, want 3", got)
	}
	// w2 still cannot fit (3+2 > 3).
	assertBlocked(t, "w2 must wait for capacity", w2Granted)
	s.Release(2) // inUse 1: w2 fits
	select {
	case <-w2Granted:
	case <-time.After(2 * time.Second):
		t.Fatal("w2 not granted once it fit")
	}
	if err := s.CheckConservation(); err != nil {
		t.Fatal(err)
	}
}

func chanErr(ch <-chan error) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		if err := <-ch; err == nil {
			close(done)
		}
	}()
	return done
}

func TestGrowUnblocksWaiters(t *testing.T) {
	s := New(1)
	s.TryAcquire(1)
	pending := acquireAsync(context.Background(), s, 3) // larger than capacity
	waitFor(t, "waiter queued", func() bool { return s.Waiters() == 1 })
	granted := chanErr(pending)
	s.Release(1)
	assertBlocked(t, "request larger than capacity", granted)
	s.Resize(3)
	select {
	case <-granted:
	case <-time.After(2 * time.Second):
		t.Fatal("waiter not granted after capacity grew")
	}
	if got := s.InUse(); got != 3 {
		t.Fatalf("InUse = %d, want 3", got)
	}
}

func TestConservationUnderConcurrency(t *testing.T) {
	// Fixed capacity: inUse must never exceed it, no matter the interleaving.
	const cap = 8
	s := New(cap)
	stop := make(chan struct{})
	var wg sync.WaitGroup

	// Watchdog sampling the invariant.
	done := make(chan struct{})
	go func() {
		for {
			select {
			case <-done:
				return
			default:
			}
			if got := s.InUse(); got > cap {
				t.Errorf("conservation violated: InUse %d > capacity %d", got, cap)
				return
			}
			if err := s.CheckConservation(); err != nil {
				t.Error(err)
				return
			}
		}
	}()

	for g := 0; g < 16; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			n := int64(g%3 + 1)
			for {
				select {
				case <-stop:
					return
				default:
				}
				if err := s.Acquire(context.Background(), n); err != nil {
					t.Error(err)
					return
				}
				time.Sleep(time.Millisecond)
				s.Release(n)
			}
		}(g)
	}
	time.Sleep(200 * time.Millisecond)
	close(stop)
	wg.Wait()
	close(done)
	if got := s.InUse(); got != 0 {
		t.Fatalf("InUse = %d after drain, want 0", got)
	}
	if err := s.CheckConservation(); err != nil {
		t.Fatal(err)
	}
}

func TestResizeInterleavedWithRelease(t *testing.T) {
	// Hammer Resize and Release concurrently; conservation must hold and the
	// semaphore must end in a consistent state.
	s := New(4)
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				n := int64(g%2 + 1)
				if s.TryAcquire(n) {
					s.Release(n)
				}
				if i%7 == 0 {
					s.Resize(int64(1 + (g+i)%6))
				}
				if err := s.CheckConservation(); err != nil {
					t.Error(err)
					return
				}
			}
		}(g)
	}
	wg.Wait()
	s.Resize(4)
	if err := s.CheckConservation(); err != nil {
		t.Fatal(err)
	}
	if got := s.InUse(); got != 0 {
		t.Fatalf("InUse = %d, want 0", got)
	}
}

func TestAcquireAlreadyCancelledContext(t *testing.T) {
	s := New(1)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := s.Acquire(ctx, 1); err != context.Canceled {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if got := s.InUse(); got != 0 {
		t.Fatalf("InUse = %d, want 0", got)
	}
}

func TestTryAcquireDoesNotJumpQueue(t *testing.T) {
	s := New(2)
	s.TryAcquire(2)
	pending := acquireAsync(context.Background(), s, 1)
	waitFor(t, "waiter queued", func() bool { return s.Waiters() == 1 })
	s.Release(2) // granted straight to the queued waiter
	if err := <-pending; err != nil {
		t.Fatal(err)
	}
	s.TryAcquire(1) // refill so a waiter queues again
	s.Release(1)
	pending2 := acquireAsync(context.Background(), s, 2)
	waitFor(t, "waiter queued again", func() bool { return s.Waiters() == 1 })
	if s.TryAcquire(1) {
		t.Fatal("TryAcquire jumped the FIFO queue")
	}
	s.Release(1)
	if err := <-pending2; err != nil {
		t.Fatal(err)
	}
}
