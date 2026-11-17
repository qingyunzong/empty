package formal

import (
	"errors"
	"sync"
	"testing"
	"time"
)

func testPolicy() Policy {
	return Policy{
		Window:                10 * time.Second,
		Buckets:               10,
		MinRequests:           4,
		FailureRate:           0.75,
		SlowRate:              0.75,
		SlowThreshold:         100 * time.Millisecond,
		OpenTimeout:           5 * time.Second,
		HalfOpenMaxConcurrent: 2,
		HalfOpenSuccesses:     2,
	}
}

func TestBreakerUsesIndependentFailureAndSlowThresholds(t *testing.T) {
	t.Run("failure threshold", func(t *testing.T) {
		clock := NewVirtualClock(time.Unix(1_700_000_000, 0))
		policy := testPolicy()
		policy.FailureRate = 0.5
		policy.SlowRate = 1
		breaker, err := NewBreakerWithClock(policy, clock)
		if err != nil {
			t.Fatal(err)
		}

		for range 3 {
			permit, err := breaker.Acquire()
			if err != nil {
				t.Fatal(err)
			}
			permit.DoneWithLatency(true, time.Millisecond)
		}
		permit, err := breaker.Acquire()
		if err != nil {
			t.Fatal(err)
		}
		permit.DoneWithLatency(false, time.Millisecond)

		if got := breaker.State(); got != StateOpen {
			t.Fatalf("state = %s, want open", got)
		}
		snapshot := breaker.Snapshot()
		if snapshot.Failures != 3 || snapshot.SlowCalls != 0 {
			t.Fatalf("snapshot = %+v, want three failures and no slow calls", snapshot)
		}
	})

	t.Run("slow threshold", func(t *testing.T) {
		clock := NewVirtualClock(time.Unix(1_700_000_000, 0))
		policy := testPolicy()
		policy.FailureRate = 1
		policy.SlowRate = 0.5
		breaker, err := NewBreakerWithClock(policy, clock)
		if err != nil {
			t.Fatal(err)
		}

		for range 3 {
			permit, err := breaker.Acquire()
			if err != nil {
				t.Fatal(err)
			}
			permit.DoneWithLatency(false, 250*time.Millisecond)
		}
		if got := breaker.State(); got != StateClosed {
			t.Fatalf("state = %s before minimum sample count, want closed", got)
		}
		permit, err := breaker.Acquire()
		if err != nil {
			t.Fatal(err)
		}
		permit.DoneWithLatency(false, 250*time.Millisecond)

		if got := breaker.State(); got != StateOpen {
			t.Fatalf("state = %s, want open", got)
		}
		snapshot := breaker.Snapshot()
		if snapshot.Failures != 0 || snapshot.SlowCalls != 4 {
			t.Fatalf("snapshot = %+v, want four slow calls and no failures", snapshot)
		}
	})
}

func TestBreakerSlidingWindowExpiresSamples(t *testing.T) {
	clock := NewVirtualClock(time.Unix(1_700_000_000, 0))
	policy := testPolicy()
	policy.MinRequests = 3
	policy.FailureRate = 0.8
	policy.SlowRate = 1
	breaker, err := NewBreakerWithClock(policy, clock)
	if err != nil {
		t.Fatal(err)
	}

	for _, failed := range []bool{true, true, false} {
		permit, err := breaker.Acquire()
		if err != nil {
			t.Fatal(err)
		}
		permit.DoneWithLatency(failed, time.Millisecond)
	}
	if got := breaker.State(); got != StateClosed {
		t.Fatalf("state = %s, want closed", got)
	}

	clock.Advance(policy.Window)
	if snapshot := breaker.Snapshot(); snapshot.Total != 0 {
		t.Fatalf("window contains %d samples after expiry, want 0", snapshot.Total)
	}

	permit, err := breaker.Acquire()
	if err != nil {
		t.Fatal(err)
	}
	permit.DoneWithLatency(false, time.Millisecond)
	permit, err = breaker.Acquire()
	if err != nil {
		t.Fatal(err)
	}
	permit.DoneWithLatency(false, time.Millisecond)
	if got := breaker.State(); got != StateClosed {
		t.Fatalf("expired failures reopened breaker: %s", got)
	}
	if snapshot := breaker.Snapshot(); snapshot.Total != 2 || snapshot.Failures != 0 {
		t.Fatalf("snapshot = %+v, want only the two new successes", snapshot)
	}
}

func TestBreakerConcurrentHalfOpenProbeLimit(t *testing.T) {
	clock := NewVirtualClock(time.Unix(1_700_000_000, 0))
	policy := testPolicy()
	policy.MinRequests = 1
	policy.OpenTimeout = time.Second
	policy.HalfOpenMaxConcurrent = 3
	policy.HalfOpenSuccesses = 3
	breaker, err := NewBreakerWithClock(policy, clock)
	if err != nil {
		t.Fatal(err)
	}

	permit, err := breaker.Acquire()
	if err != nil {
		t.Fatal(err)
	}
	permit.Failure()
	if got := breaker.State(); got != StateOpen {
		t.Fatalf("state = %s, want open", got)
	}
	if _, err := breaker.Acquire(); !errors.Is(err, ErrOpen) {
		t.Fatalf("open acquire error = %v, want ErrOpen", err)
	}

	clock.Advance(policy.OpenTimeout)
	if got := breaker.State(); got != StateHalfOpen {
		t.Fatalf("state = %s, want half-open", got)
	}

	const attempts = 32
	start := make(chan struct{})
	permits := make(chan *Permit, attempts)
	errs := make(chan error, attempts)
	var wait sync.WaitGroup
	for range attempts {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			permit, err := breaker.Acquire()
			if err != nil {
				errs <- err
				return
			}
			permits <- permit
		}()
	}
	close(start)
	wait.Wait()
	close(permits)
	close(errs)

	var admitted []*Permit
	for permit := range permits {
		admitted = append(admitted, permit)
	}
	if len(admitted) != policy.HalfOpenMaxConcurrent {
		t.Fatalf("admitted %d probes, want %d", len(admitted), policy.HalfOpenMaxConcurrent)
	}
	for err := range errs {
		if !errors.Is(err, ErrOpen) {
			t.Fatalf("probe rejection error = %v, want ErrOpen", err)
		}
	}

	for _, permit := range admitted {
		permit.Success()
		permit.Failure() // A duplicate finish must be ignored.
	}
	if got := breaker.State(); got != StateClosed {
		t.Fatalf("state = %s after enough successful probes, want closed", got)
	}
}

func TestBreakerLateProbeCannotOverrideReopen(t *testing.T) {
	clock := NewVirtualClock(time.Unix(1_700_000_000, 0))
	policy := testPolicy()
	policy.MinRequests = 1
	policy.OpenTimeout = time.Second
	policy.HalfOpenMaxConcurrent = 2
	policy.HalfOpenSuccesses = 2
	breaker, err := NewBreakerWithClock(policy, clock)
	if err != nil {
		t.Fatal(err)
	}

	permit, err := breaker.Acquire()
	if err != nil {
		t.Fatal(err)
	}
	permit.Failure()
	clock.Advance(policy.OpenTimeout)

	first, err := breaker.Acquire()
	if err != nil {
		t.Fatal(err)
	}
	second, err := breaker.Acquire()
	if err != nil {
		t.Fatal(err)
	}
	first.Failure()
	if got := breaker.State(); got != StateOpen {
		t.Fatalf("state = %s after failed probe, want open", got)
	}

	second.Success()
	if got := breaker.State(); got != StateOpen {
		t.Fatalf("late success changed state to %s, want open", got)
	}
	clock.Advance(policy.OpenTimeout - time.Nanosecond)
	if got := breaker.State(); got != StateOpen {
		t.Fatalf("state = %s before a fresh open timeout, want open", got)
	}
	clock.Advance(time.Nanosecond)
	if got := breaker.State(); got != StateHalfOpen {
		t.Fatalf("state = %s after a fresh open timeout, want half-open", got)
	}
}
