package circuitbreaker

import (
	"errors"
	"sync"
	"testing"
	"time"
)

// fakeClock is a manually advanced clock for deterministic tests.
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

func mustAllow(t *testing.T, b *Breaker) uint64 {
	t.Helper()
	gen, err := b.Allow()
	if err != nil {
		t.Fatalf("Allow() unexpected error: %v", err)
	}
	return gen
}

func TestClosedPassesRequests(t *testing.T) {
	b := New(3, time.Minute, 2, newFakeClock())
	for i := 0; i < 10; i++ {
		gen := mustAllow(t, b)
		b.Success(gen)
	}
	if got := b.State(); got != StateClosed {
		t.Fatalf("state = %v, want closed", got)
	}
}

func TestFailureThresholdTripsOpen(t *testing.T) {
	b := New(3, time.Minute, 2, newFakeClock())

	// Two failures: below threshold, still closed.
	for i := 0; i < 2; i++ {
		b.Failure(mustAllow(t, b))
	}
	if got := b.State(); got != StateClosed {
		t.Fatalf("after 2 failures state = %v, want closed", got)
	}

	// Third consecutive failure reaches the threshold -> open.
	b.Failure(mustAllow(t, b))
	if got := b.State(); got != StateOpen {
		t.Fatalf("after 3 failures state = %v, want open", got)
	}
}

func TestSuccessResetsConsecutiveFailures(t *testing.T) {
	b := New(2, time.Minute, 1, newFakeClock())
	b.Failure(mustAllow(t, b))
	b.Success(mustAllow(t, b)) // reset the streak
	b.Failure(mustAllow(t, b))
	if got := b.State(); got != StateClosed {
		t.Fatalf("state = %v, want closed (streak was reset)", got)
	}
	b.Failure(mustAllow(t, b))
	if got := b.State(); got != StateOpen {
		t.Fatalf("state = %v, want open", got)
	}
}

func TestOpenRejectsNormalRequests(t *testing.T) {
	b := New(1, time.Minute, 1, newFakeClock())
	b.Failure(mustAllow(t, b)) // trip open

	if _, err := b.Allow(); !errors.Is(err, ErrOpen) {
		t.Fatalf("Allow() err = %v, want ErrOpen", err)
	}
	if err := b.Execute(func() error { return nil }); !errors.Is(err, ErrOpen) {
		t.Fatalf("Execute() err = %v, want ErrOpen", err)
	}
}

func TestOpenStaysOpenUntilDurationElapses(t *testing.T) {
	clock := newFakeClock()
	b := New(1, 30*time.Second, 1, clock)
	b.Failure(mustAllow(t, b)) // trip open at t0

	clock.Advance(29 * time.Second)
	if _, err := b.Allow(); !errors.Is(err, ErrOpen) {
		t.Fatalf("before openDuration: err = %v, want ErrOpen", err)
	}
	if got := b.State(); got != StateOpen {
		t.Fatalf("before openDuration: state = %v, want open", got)
	}

	clock.Advance(1 * time.Second) // exactly 30s elapsed
	if got := b.State(); got != StateHalfOpen {
		t.Fatalf("after openDuration: state = %v, want half-open", got)
	}
}

func TestHalfOpenAllowsAtMostKProbes(t *testing.T) {
	clock := newFakeClock()
	b := New(1, time.Second, 2, clock) // K = 2
	b.Failure(mustAllow(t, b))
	clock.Advance(time.Second)

	if got := b.State(); got != StateHalfOpen {
		t.Fatalf("state = %v, want half-open", got)
	}
	mustAllow(t, b) // probe 1
	mustAllow(t, b) // probe 2
	if _, err := b.Allow(); !errors.Is(err, ErrTooManyProbes) {
		t.Fatalf("3rd probe err = %v, want ErrTooManyProbes", err)
	}
}

func TestHalfOpenProbeSuccessCloses(t *testing.T) {
	clock := newFakeClock()
	b := New(1, time.Second, 2, clock)
	b.Failure(mustAllow(t, b))
	clock.Advance(time.Second)

	probe := mustAllow(t, b)
	b.Success(probe)
	if got := b.State(); got != StateClosed {
		t.Fatalf("state = %v, want closed", got)
	}
	// Normal traffic flows again.
	mustAllow(t, b)
}

func TestHalfOpenProbeFailureReopensAndRestartsTimer(t *testing.T) {
	clock := newFakeClock()
	b := New(1, 10*time.Second, 1, clock)
	b.Failure(mustAllow(t, b)) // open at t0
	clock.Advance(10 * time.Second)

	probe := mustAllow(t, b) // half-open probe
	clock.Advance(3 * time.Second)
	b.Failure(probe) // probe fails -> re-open at t0+13s

	if got := b.State(); got != StateOpen {
		t.Fatalf("state = %v, want open", got)
	}
	if _, err := b.Allow(); !errors.Is(err, ErrOpen) {
		t.Fatalf("err = %v, want ErrOpen", err)
	}

	// Timer restarted: 9s after re-open is not enough.
	clock.Advance(9 * time.Second)
	if got := b.State(); got != StateOpen {
		t.Fatalf("state = %v, want open (timer restarted)", got)
	}
	clock.Advance(1 * time.Second)
	if got := b.State(); got != StateHalfOpen {
		t.Fatalf("state = %v, want half-open", got)
	}
}

func TestLateSuccessCannotCloseNewOpenGeneration(t *testing.T) {
	clock := newFakeClock()
	b := New(1, 10*time.Second, 2, clock)
	b.Failure(mustAllow(t, b)) // open (gen g1)
	clock.Advance(10 * time.Second)

	// Half-open (gen g2): two probes in flight.
	slowProbe := mustAllow(t, b)
	failingProbe := mustAllow(t, b)

	// The failing probe re-opens the breaker -> new generation g3.
	b.Failure(failingProbe)
	if got := b.State(); got != StateOpen {
		t.Fatalf("state = %v, want open", got)
	}
	newGen := b.Generation()

	// The slow probe's success arrives late, from the old generation g2.
	// It must NOT close the newly opened generation.
	b.Success(slowProbe)
	if got := b.State(); got != StateOpen {
		t.Fatalf("late success closed the breaker: state = %v, want open", got)
	}
	if got := b.Generation(); got != newGen {
		t.Fatalf("generation changed to %d, want %d", got, newGen)
	}
}

func TestLateFailureDoesNotAffectNewGeneration(t *testing.T) {
	clock := newFakeClock()
	b := New(2, 10*time.Second, 1, clock)

	// Gen g1: one failure (below threshold of 2), then success resets,
	// then trip open via two fresh failures.
	b.Failure(mustAllow(t, b))
	b.Success(mustAllow(t, b))
	b.Failure(mustAllow(t, b))
	b.Failure(mustAllow(t, b)) // open, gen g2
	clock.Advance(10 * time.Second)

	// Half-open probe (gen g3) succeeds -> closed, gen g4.
	probe := mustAllow(t, b)
	b.Success(probe)
	if got := b.State(); got != StateClosed {
		t.Fatalf("state = %v, want closed", got)
	}

	// A stale failure from gen g1 must not count toward the new threshold.
	b.Failure(1)
	if got := b.State(); got != StateClosed {
		t.Fatalf("stale failure changed state to %v, want closed", got)
	}
	// One real failure is still below threshold 2.
	b.Failure(mustAllow(t, b))
	if got := b.State(); got != StateClosed {
		t.Fatalf("state = %v, want closed (stale failure must not count)", got)
	}
}

func TestStaleProbeResultAfterRecoveryIsIgnored(t *testing.T) {
	clock := newFakeClock()
	b := New(1, time.Second, 2, clock)
	b.Failure(mustAllow(t, b))
	clock.Advance(time.Second)

	// Two half-open probes; first succeeds -> closed (new generation).
	probe1 := mustAllow(t, b)
	probe2 := mustAllow(t, b)
	b.Success(probe1)
	if got := b.State(); got != StateClosed {
		t.Fatalf("state = %v, want closed", got)
	}

	// probe2's late failure belongs to the half-open generation; ignored.
	b.Failure(probe2)
	if got := b.State(); got != StateClosed {
		t.Fatalf("state = %v, want closed", got)
	}
}

func TestExecuteRecordsOutcome(t *testing.T) {
	b := New(2, time.Minute, 1, newFakeClock())

	if err := b.Execute(func() error { return nil }); err != nil {
		t.Fatalf("Execute() err = %v", err)
	}
	if err := b.Execute(func() error { return errors.New("boom") }); err == nil {
		t.Fatal("Execute() should propagate fn error")
	}
	if err := b.Execute(func() error { return errors.New("boom") }); err == nil {
		t.Fatal("Execute() should propagate fn error")
	}
	if got := b.State(); got != StateOpen {
		t.Fatalf("state = %v, want open after 2 failures", got)
	}
}

func TestConcurrentProbesRespectLimit(t *testing.T) {
	clock := newFakeClock()
	b := New(1, time.Second, 3, clock)
	b.Failure(mustAllow(t, b))
	clock.Advance(time.Second)

	var wg sync.WaitGroup
	allowed := make(chan uint64, 16)
	rejected := make(chan error, 16)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if gen, err := b.Allow(); err == nil {
				allowed <- gen
			} else {
				rejected <- err
			}
		}()
	}
	wg.Wait()
	close(allowed)
	close(rejected)

	var gens []uint64
	for gen := range allowed {
		gens = append(gens, gen)
	}
	if len(gens) != 3 {
		t.Fatalf("allowed probes = %d, want 3", len(gens))
	}
	for err := range rejected {
		if !errors.Is(err, ErrTooManyProbes) {
			t.Fatalf("rejection err = %v, want ErrTooManyProbes", err)
		}
	}
	// All admitted probes share the same half-open generation.
	for _, gen := range gens {
		if gen != gens[0] {
			t.Fatalf("probe generations differ: %v", gens)
		}
	}
}
