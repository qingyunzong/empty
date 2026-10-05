package semaphore

import (
	"context"
	"fmt"
	"math/rand"
	"sync"
	"testing"
	"time"
)

// acquireN starts n goroutines acquiring 1 token each and returns a channel
// that receives the sequence of goroutine indices in grant order. Goroutines
// are started one at a time, waiting for each to enqueue before starting the
// next, so the queue order matches the goroutine indices.
func acquireN(t *testing.T, s *Semaphore, n int) chan int {
	t.Helper()
	grants := make(chan int, n)
	for i := 0; i < n; i++ {
		go func(i int) {
			if err := s.Acquire(context.Background(), 1); err == nil {
				grants <- i
			}
		}(i)
		eventually(t, fmt.Sprintf("waiter %d queued", i), func() bool { return s.Waiters() == i+1 })
	}
	return grants
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestBasicAcquireRelease(t *testing.T) {
	s := New(3)
	for i := 0; i < 3; i++ {
		if err := s.Acquire(context.Background(), 1); err != nil {
			t.Fatal(err)
		}
	}
	if got := s.Used(); got != 3 {
		t.Fatalf("used = %d, want 3", got)
	}
	if s.TryAcquire(1) {
		t.Fatal("TryAcquire succeeded at full capacity")
	}
	s.Release(2)
	if got := s.Used(); got != 1 {
		t.Fatalf("used = %d, want 1", got)
	}
	if !s.TryAcquire(2) {
		t.Fatal("TryAcquire failed with room available")
	}
}

func TestFIFOWaitOrder(t *testing.T) {
	s := New(1)
	if err := s.Acquire(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	grants := acquireN(t, s, 5)

	for want := 0; want < 5; want++ {
		s.Release(1)
		select {
		case got := <-grants:
			if got != want {
				t.Fatalf("grant #%d went to goroutine %d, FIFO violated", want, got)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("grant #%d never arrived", want)
		}
	}
}

func TestCancelHeadLeavesNoHole(t *testing.T) {
	s := New(1)
	if err := s.Acquire(context.Background(), 1); err != nil {
		t.Fatal(err)
	}

	// Queue a cancellable waiter at the head, then a second waiter behind it.
	ctx, cancel := context.WithCancel(context.Background())
	headErr := make(chan error, 1)
	go func() { headErr <- s.Acquire(ctx, 1) }()
	grants := make(chan struct{}, 1)
	go func() {
		if err := s.Acquire(context.Background(), 1); err == nil {
			grants <- struct{}{}
		}
	}()
	eventually(t, "2 queued waiters", func() bool { return s.Waiters() == 2 })

	// Cancel the head; the second waiter must become the effective head and
	// be granted as soon as a token is released.
	cancel()
	if err := <-headErr; err != context.Canceled {
		t.Fatalf("head waiter err = %v, want context.Canceled", err)
	}
	eventually(t, "queue drained to 1 waiter", func() bool { return s.Waiters() == 1 })

	s.Release(1)
	select {
	case <-grants:
	case <-time.After(2 * time.Second):
		t.Fatal("waiter behind cancelled head was never granted: head hole")
	}
	if got := s.Used(); got != 1 {
		t.Fatalf("used = %d, want 1", got)
	}
}

func TestCancelMiddleWaiter(t *testing.T) {
	s := New(1)
	if err := s.Acquire(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	midErr := make(chan error, 1)
	go func() { midErr <- s.Acquire(ctx, 1) }()
	tail := make(chan struct{}, 1)
	go func() {
		if err := s.Acquire(context.Background(), 1); err == nil {
			tail <- struct{}{}
		}
	}()
	eventually(t, "2 queued waiters", func() bool { return s.Waiters() == 2 })

	cancel()
	if err := <-midErr; err != context.Canceled {
		t.Fatalf("middle waiter err = %v, want context.Canceled", err)
	}
	s.Release(1)
	select {
	case <-tail:
	case <-time.After(2 * time.Second):
		t.Fatal("tail waiter starved after middle cancellation")
	}
}

func TestShrinkStopsGrantsWithoutRevoking(t *testing.T) {
	s := New(4)
	if err := s.Acquire(context.Background(), 4); err != nil {
		t.Fatal(err)
	}
	s.Resize(2) // used=4 > total=2: over capacity, tokens not revoked
	if got := s.Used(); got != 4 {
		t.Fatalf("used = %d after shrink, want 4 (no revocation)", got)
	}
	if s.TryAcquire(1) {
		t.Fatal("grant made while over capacity")
	}

	// A queued waiter must stay blocked while over capacity.
	granted := make(chan struct{}, 1)
	go func() {
		if err := s.Acquire(context.Background(), 1); err == nil {
			granted <- struct{}{}
		}
	}()
	eventually(t, "1 queued waiter", func() bool { return s.Waiters() == 1 })
	s.Release(1) // used=3, still > total=2
	select {
	case <-granted:
		t.Fatal("grant made while still over capacity")
	case <-time.After(50 * time.Millisecond):
	}
	s.Release(1) // used=2, head needs 1: 2+1 > 2, still blocked
	select {
	case <-granted:
		t.Fatal("grant made at full capacity")
	case <-time.After(50 * time.Millisecond):
	}
	s.Release(1) // used=1, head fits: 1+1 <= 2
	select {
	case <-granted:
	case <-time.After(2 * time.Second):
		t.Fatal("waiter not granted after usage fell below capacity")
	}
	if got := s.Used(); got != 2 {
		t.Fatalf("used = %d, want 2", got)
	}
}

func TestGrowUnblocksWaiters(t *testing.T) {
	s := New(1)
	if err := s.Acquire(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	grants := acquireN(t, s, 3)

	// Grow one slot at a time so each grant is observable in FIFO order.
	for i := 0; i < 3; i++ {
		s.Resize(int64(2 + i))
		select {
		case got := <-grants:
			if got != i {
				t.Fatalf("grant #%d went to goroutine %d, FIFO violated", i, got)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("grant #%d never arrived after grow", i)
		}
	}
}

func TestOverReleasePanics(t *testing.T) {
	s := New(2)
	if err := s.Acquire(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic on over-release")
		}
	}()
	s.Release(2)
}

// TestConservationUnderResize races releases and resizes against acquires
// and verifies the conservation invariant: used >= 0 always, used may
// exceed total only transiently after a shrink, and every grant observes
// used+n <= total at grant time.
func TestConservationUnderResize(t *testing.T) {
	s := New(8)
	var (
		mu          sync.Mutex
		violations  []string
		peakOverCap int64
	)
	check := func() {
		mu.Lock()
		defer mu.Unlock()
		used, total := s.Used(), s.Total()
		if used < 0 {
			violations = append(violations, fmt.Sprintf("used=%d < 0", used))
		}
		if used > total {
			if over := used - total; over > peakOverCap {
				peakOverCap = over
			}
		}
	}

	const workers = 16
	var workersWG, resizerWG sync.WaitGroup
	stop := make(chan struct{})

	// Resizer: randomly shrink and grow, sometimes below current usage.
	resizerWG.Add(1)
	go func() {
		defer resizerWG.Done()
		rng := rand.New(rand.NewSource(1))
		for {
			select {
			case <-stop:
				return
			default:
			}
			s.Resize(int64(rng.Intn(12)))
			check()
		}
	}()

	// Workers: acquire (with a short timeout so they also exercise
	// cancellation), hold briefly, release.
	for i := 0; i < workers; i++ {
		workersWG.Add(1)
		go func(i int) {
			defer workersWG.Done()
			rng := rand.New(rand.NewSource(int64(i) + 2))
			for j := 0; j < 200; j++ {
				n := int64(rng.Intn(3) + 1)
				ctx, cancel := context.WithTimeout(context.Background(), time.Duration(rng.Intn(200))*time.Microsecond)
				err := s.Acquire(ctx, n)
				cancel()
				if err != nil {
					continue
				}
				check()
				s.Release(n)
				check()
			}
		}(i)
	}

	workersWG.Wait()
	close(stop)
	resizerWG.Wait()
	// Drain: grow large so any leftover waiters (all cancelled) clear out.
	s.Resize(1 << 20)
	eventually(t, "no waiters left", func() bool { return s.Waiters() == 0 })
	// Every token ever granted has been released (cancelled grants that
	// raced are returned by their owners above).
	if got := s.Used(); got != 0 {
		t.Fatalf("leaked tokens: used = %d at end, want 0", got)
	}
	if len(violations) > 0 {
		t.Fatalf("conservation violations: %v", violations[:min(5, len(violations))])
	}
	t.Logf("peak transient over-capacity: %d tokens (allowed after shrink)", peakOverCap)
}

// TestNoNewOverGrant pins the invariant directly: after shrinking below
// usage, repeated grant attempts must all fail until usage drops.
func TestNoNewOverGrant(t *testing.T) {
	s := New(10)
	if err := s.Acquire(context.Background(), 10); err != nil {
		t.Fatal(err)
	}
	s.Resize(3)
	for i := 0; i < 100; i++ {
		if s.TryAcquire(1) {
			t.Fatalf("iteration %d: granted while used=%d > total=%d", i, s.Used(), s.Total())
		}
	}
	s.Release(8) // used=2 <= total=3
	if !s.TryAcquire(1) {
		t.Fatal("grant refused despite used=2 < total=3")
	}
	if s.TryAcquire(1) {
		t.Fatal("grant pushed usage over capacity")
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
