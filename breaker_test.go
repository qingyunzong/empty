package breaker

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeClock is a controlled clock: time only moves when Advance is called.
type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

func newTestBreaker(clk *fakeClock, threshold, maxProbes, requiredSuccesses int, openDur time.Duration) *Breaker {
	return New(Options{
		FailureThreshold:  threshold,
		OpenDuration:      openDur,
		MaxProbes:         maxProbes,
		RequiredSuccesses: requiredSuccesses,
		Clock:             clk,
	})
}

func mustAcquire(t *testing.T, b *Breaker) *Permit {
	t.Helper()
	p, err := b.Acquire()
	if err != nil {
		t.Fatalf("Acquire: unexpected error: %v", err)
	}
	return p
}

// failClosed reports n failures through freshly acquired closed-state permits.
func failClosed(t *testing.T, b *Breaker, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		mustAcquire(t, b).Failure()
	}
}

func TestFailureThresholdTripsOpen(t *testing.T) {
	clk := newFakeClock()
	b := newTestBreaker(clk, 3, 1, 1, time.Minute)

	failClosed(t, b, 2)
	if got := b.State(); got != StateClosed {
		t.Fatalf("after 2 failures (threshold 3): state = %v, want closed", got)
	}

	failClosed(t, b, 1)
	if got := b.State(); got != StateOpen {
		t.Fatalf("after 3rd consecutive failure: state = %v, want open", got)
	}
}

func TestSuccessResetsConsecutiveFailures(t *testing.T) {
	clk := newFakeClock()
	b := newTestBreaker(clk, 3, 1, 1, time.Minute)

	failClosed(t, b, 2)
	mustAcquire(t, b).Success()
	failClosed(t, b, 2) // 2 again, not 4: the counter was reset

	if got := b.State(); got != StateClosed {
		t.Fatalf("state = %v, want closed (success must reset the failure count)", got)
	}
	failClosed(t, b, 1)
	if got := b.State(); got != StateOpen {
		t.Fatalf("state = %v, want open", got)
	}
}

func TestOpenRejectsUntilCooldownElapses(t *testing.T) {
	clk := newFakeClock()
	b := newTestBreaker(clk, 1, 1, 1, time.Minute)

	failClosed(t, b, 1) // trips open immediately

	if _, err := b.Acquire(); !errors.Is(err, ErrOpen) {
		t.Fatalf("open breaker: Acquire err = %v, want ErrOpen", err)
	}

	clk.Advance(59 * time.Second)
	if _, err := b.Acquire(); !errors.Is(err, ErrOpen) {
		t.Fatalf("before cooldown: Acquire err = %v, want ErrOpen", err)
	}

	clk.Advance(1 * time.Second) // exactly OpenDuration elapsed
	p, err := b.Acquire()
	if err != nil {
		t.Fatalf("after cooldown: Acquire err = %v, want a probe permit", err)
	}
	if got := b.State(); got != StateHalfOpen {
		t.Fatalf("state = %v, want half-open", got)
	}
	p.Success()
	if got := b.State(); got != StateClosed {
		t.Fatalf("after successful probe: state = %v, want closed", got)
	}
}

func TestHalfOpenAdmitsAtMostKProbes(t *testing.T) {
	clk := newFakeClock()
	b := newTestBreaker(clk, 1, 2, 2, time.Minute)

	failClosed(t, b, 1)
	clk.Advance(time.Minute)

	p1 := mustAcquire(t, b)
	p2 := mustAcquire(t, b)
	if _, err := b.Acquire(); !errors.Is(err, ErrProbeLimit) {
		t.Fatalf("3rd concurrent probe: err = %v, want ErrProbeLimit", err)
	}

	// A settled probe frees its slot for the next one.
	p1.Success()
	p3 := mustAcquire(t, b)
	_ = p2
	p3.Success() // reaches RequiredSuccesses=2 -> closed
	if got := b.State(); got != StateClosed {
		t.Fatalf("state = %v, want closed", got)
	}
}

func TestProbeFailureReopensWithNewGeneration(t *testing.T) {
	clk := newFakeClock()
	b := newTestBreaker(clk, 1, 1, 1, time.Minute)

	failClosed(t, b, 1)
	clk.Advance(time.Minute)
	genHalfOpen := b.Generation()

	mustAcquire(t, b).Failure() // probe fails -> open again

	if got := b.State(); got != StateOpen {
		t.Fatalf("state = %v, want open", got)
	}
	if gen := b.Generation(); gen <= genHalfOpen {
		t.Fatalf("generation = %d, want > %d after re-open", gen, genHalfOpen)
	}
	if _, err := b.Acquire(); !errors.Is(err, ErrOpen) {
		t.Fatalf("re-opened breaker: err = %v, want ErrOpen", err)
	}

	// Cooldown restarts from the re-open moment.
	clk.Advance(59 * time.Second)
	if _, err := b.Acquire(); !errors.Is(err, ErrOpen) {
		t.Fatalf("cooldown must restart on re-open: err = %v, want ErrOpen", err)
	}
	clk.Advance(1 * time.Second)
	mustAcquire(t, b).Success()
	if got := b.State(); got != StateClosed {
		t.Fatalf("state = %v, want closed", got)
	}
}

// The core staleness guarantee: a probe from half-open episode N is still in
// flight when a sibling probe fails and re-opens the breaker (generation
// N+1). The late success must not close the new open generation.
func TestLateSuccessDoesNotCloseNewGeneration(t *testing.T) {
	clk := newFakeClock()
	b := newTestBreaker(clk, 1, 2, 2, time.Minute)

	failClosed(t, b, 1)
	clk.Advance(time.Minute)

	slow := mustAcquire(t, b) // probe that will succeed, but late
	fast := mustAcquire(t, b) // probe that fails first
	fast.Failure()            // -> open, new generation
	genOpen := b.Generation()

	slow.Success() // late success from the previous generation

	if got := b.State(); got != StateOpen {
		t.Fatalf("late success closed the breaker: state = %v, want open", got)
	}
	if gen := b.Generation(); gen != genOpen {
		t.Fatalf("generation = %d, want unchanged %d", gen, genOpen)
	}
	if _, err := b.Acquire(); !errors.Is(err, ErrOpen) {
		t.Fatalf("breaker must still reject: err = %v, want ErrOpen", err)
	}

	// The new generation recovers only through its own probes.
	clk.Advance(time.Minute)
	mustAcquire(t, b).Success()
	if got := b.State(); got != StateHalfOpen {
		t.Fatalf("one success of two required: state = %v, want half-open", got)
	}
	mustAcquire(t, b).Success()
	if got := b.State(); got != StateClosed {
		t.Fatalf("state = %v, want closed", got)
	}
}

// Stale results from a previous generation must not perturb the closed state
// either: neither a late failure nor a late success may count.
func TestStaleResultsIgnoredAfterGenerationChange(t *testing.T) {
	clk := newFakeClock()
	b := newTestBreaker(clk, 2, 1, 1, time.Minute)

	stale := mustAcquire(t, b) // closed-state request left in flight
	failClosed(t, b, 2)        // trips open, generation changes
	clk.Advance(time.Minute)
	mustAcquire(t, b).Success() // probe closes the breaker again

	stale.Failure() // late failure from an old generation: must be ignored
	if got := b.State(); got != StateClosed {
		t.Fatalf("stale failure changed state: %v, want closed", got)
	}

	// Prove the stale failure was not counted: one fresh failure must not
	// trip a breaker with threshold 2.
	failClosed(t, b, 1)
	if got := b.State(); got != StateClosed {
		t.Fatalf("stale failure was counted: state = %v, want closed", got)
	}
}

func TestDoubleReportIsNoOp(t *testing.T) {
	clk := newFakeClock()
	b := newTestBreaker(clk, 2, 1, 1, time.Minute)

	p := mustAcquire(t, b)
	p.Failure()
	p.Failure() // ignored: permit already settled
	if got := b.State(); got != StateClosed {
		t.Fatalf("double report counted twice: state = %v, want closed", got)
	}
}

func TestConcurrentProbeLimitNeverExceeded(t *testing.T) {
	clk := newFakeClock()
	const k = 3
	b := newTestBreaker(clk, 1, k, 1, time.Minute)

	failClosed(t, b, 1)
	clk.Advance(time.Minute)

	var inFlight, maxSeen atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			p, err := b.Acquire()
			if err != nil {
				return // ErrProbeLimit is expected under contention
			}
			cur := inFlight.Add(1)
			for {
				m := maxSeen.Load()
				if cur <= m || maxSeen.CompareAndSwap(m, cur) {
					break
				}
			}
			inFlight.Add(-1)
			p.Failure() // first failure re-opens; stale permits are dropped
		}()
	}
	wg.Wait()

	if m := maxSeen.Load(); m > k {
		t.Fatalf("concurrent probes peaked at %d, want <= %d", m, k)
	}
	if got := b.State(); got != StateOpen {
		t.Fatalf("state = %v, want open after probe failure", got)
	}
}

func TestStateString(t *testing.T) {
	states := map[State]string{
		StateClosed:   "closed",
		StateOpen:     "open",
		StateHalfOpen: "half-open",
	}
	for s, want := range states {
		if got := s.String(); got != want {
			t.Errorf("State(%d).String() = %q, want %q", int(s), got, want)
		}
	}
}
