package dedup_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"example.com/dedupsub/dedup"
)

// blockingStarter returns a Starter whose upstream blocks until release is
// closed or its context is cancelled, plus counters for starts and
// upstream cancellations.
func blockingStarter(release <-chan struct{}) (dedup.Starter, *atomic.Int64, *atomic.Int64) {
	var starts, cancels atomic.Int64
	return func(ctx context.Context, key string) (any, error) {
		starts.Add(1)
		select {
		case <-release:
			return key + "-value", nil
		case <-ctx.Done():
			cancels.Add(1)
			return nil, ctx.Err()
		}
	}, &starts, &cancels
}

func waitDone(t *testing.T, s *dedup.Subscription) {
	t.Helper()
	select {
	case <-s.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("subscription did not terminate")
	}
}

func TestSameKeySharesOneUpstream(t *testing.T) {
	release := make(chan struct{})
	start, starts, _ := blockingStarter(release)
	m := dedup.NewManager(start)

	const n = 8
	var delivered atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		s := m.Subscribe("k", func(r dedup.Result) {
			if r.Err != nil || r.Value != "k-value" {
				t.Errorf("unexpected result: %+v", r)
			}
			delivered.Add(1)
			wg.Done()
		})
		defer waitDone(t, s)
	}
	close(release)
	wg.Wait()
	if got := starts.Load(); got != 1 {
		t.Fatalf("upstream started %d times, want 1", got)
	}
	if got := delivered.Load(); got != n {
		t.Fatalf("delivered to %d subscribers, want %d", got, n)
	}
}

func TestLastCancelCancelsUpstream(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	start, starts, cancels := blockingStarter(release)
	m := dedup.NewManager(start)

	s1 := m.Subscribe("k", nil)
	s2 := m.Subscribe("k", nil)

	s1.Cancel()
	waitDone(t, s1)
	if got := cancels.Load(); got != 0 {
		t.Fatalf("upstream cancelled with a subscriber still active")
	}

	s2.Cancel()
	waitDone(t, s2)
	deadline := time.After(5 * time.Second)
	for cancels.Load() != 1 {
		select {
		case <-deadline:
			t.Fatal("upstream context not cancelled after last cancel")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	if got := starts.Load(); got != 1 {
		t.Fatalf("upstream started %d times, want 1", got)
	}
	if _, err := s1.Result(); !errors.Is(err, dedup.ErrCancelled) {
		t.Fatalf("s1 terminal error = %v, want ErrCancelled", err)
	}
}

func TestNewSubscribeAfterCancelStartsNewGeneration(t *testing.T) {
	// The first generation's starter stays alive (blocked on gate) even
	// after its context is cancelled, so the second Subscribe must provably
	// not rejoin the cancelled generation.
	firstStarted := make(chan struct{})
	firstCancelled := make(chan struct{})
	gate := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int64
	m := dedup.NewManager(func(ctx context.Context, key string) (any, error) {
		if calls.Add(1) == 1 {
			close(firstStarted)
			<-ctx.Done()
			close(firstCancelled)
			<-gate // first generation still unwinding
			return nil, ctx.Err()
		}
		select {
		case <-release:
			return key + "-value", nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	})

	s1 := m.Subscribe("k", nil)
	<-firstStarted
	s1.Cancel()
	waitDone(t, s1)
	<-firstCancelled // upstream observed the cancel; generation is torn down

	var got atomic.Value
	s2 := m.Subscribe("k", func(r dedup.Result) { got.Store(r.Value) })
	deadline := time.After(5 * time.Second)
	for calls.Load() != 2 {
		select {
		case <-deadline:
			t.Fatal("second generation never started")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	close(gate)
	close(release)
	waitDone(t, s2)

	if got.Load() != "k-value" {
		t.Fatalf("second generation got %v, want k-value", got.Load())
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("upstream started %d times, want 2", got)
	}
}

func TestCompletionNotifiesOnlyActiveSubscribers(t *testing.T) {
	release := make(chan struct{})
	start, _, cancels := blockingStarter(release)
	m := dedup.NewManager(start)

	var notified atomic.Int64
	cb := func(dedup.Result) { notified.Add(1) }
	s1 := m.Subscribe("k", cb)
	s2 := m.Subscribe("k", cb)
	s3 := m.Subscribe("k", cb)

	s2.Cancel()
	close(release)
	waitDone(t, s1)
	waitDone(t, s2)
	waitDone(t, s3)

	if got := notified.Load(); got != 2 {
		t.Fatalf("notified %d subscribers, want 2", got)
	}
	if got := cancels.Load(); got != 0 {
		t.Fatalf("upstream cancelled %d times, want 0 (active subscribers remain)", got)
	}
	if v, err := s1.Result(); err != nil || v != "k-value" {
		t.Fatalf("s1 = %v, %v; want k-value, nil", v, err)
	}
	if _, err := s2.Result(); !errors.Is(err, dedup.ErrCancelled) {
		t.Fatalf("s2 terminal error = %v, want ErrCancelled", err)
	}
}

func TestCallbackMayReentrantlySubscribe(t *testing.T) {
	// If callbacks were invoked under the manager lock, the reentrant
	// Subscribe below would deadlock; the test times out in that case.
	var starts atomic.Int64
	m := dedup.NewManager(func(ctx context.Context, key string) (any, error) {
		n := starts.Add(1)
		return fmt.Sprintf("gen-%d", n), nil
	})

	done := make(chan struct{})
	var inner atomic.Value
	s1 := m.Subscribe("k", func(r dedup.Result) {
		defer close(done)
		if r.Value != "gen-1" {
			t.Errorf("outer got %v, want gen-1", r.Value)
		}
		// Reentrant subscribe: the completed generation is closed, so
		// this must start a fresh generation rather than join the old one.
		s2 := m.Subscribe("k", func(r2 dedup.Result) { inner.Store(r2.Value) })
		waitDone(t, s2)
	})
	waitDone(t, s1)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("reentrant callback deadlocked")
	}
	if inner.Load() != "gen-2" {
		t.Fatalf("inner subscription got %v, want gen-2", inner.Load())
	}
	if got := starts.Load(); got != 2 {
		t.Fatalf("upstream started %d times, want 2", got)
	}
}

func TestCallbackMayReentrantlyCancelOther(t *testing.T) {
	release := make(chan struct{})
	start, _, _ := blockingStarter(release)
	m := dedup.NewManager(start)

	var s2 *dedup.Subscription
	s1 := m.Subscribe("k", func(dedup.Result) { s2.Cancel() })
	s2 = m.Subscribe("k", nil)
	close(release)
	waitDone(t, s1)
	waitDone(t, s2)
	// s2 was still active when the upstream completed, so its delivery
	// legitimately races with the cancel issued from s1's callback; either
	// terminal state is valid, but it must be exactly one of them.
	v, err := s2.Result()
	switch {
	case errors.Is(err, dedup.ErrCancelled):
		t.Log("s2 cancelled before its delivery ran")
	case err == nil && v == "k-value":
		t.Log("s2 delivered before the reentrant cancel ran")
	default:
		t.Fatalf("s2 terminal state = %v, %v; want k-value or ErrCancelled", v, err)
	}
}

// TestExactlyOneTerminalStatePerSubscription hammers the manager with
// concurrent subscribers, cancels, and completions, then uses a WaitGroup
// barrier to verify every subscription settled into exactly one terminal
// state and every callback fired at most once.
func TestExactlyOneTerminalStatePerSubscription(t *testing.T) {
	release := make(chan struct{})
	start, _, _ := blockingStarter(release)
	m := dedup.NewManager(start)

	const n = 300
	callbacks := make([]atomic.Int64, n)
	subs := make([]*dedup.Subscription, n)

	var barrier sync.WaitGroup
	barrier.Add(n)
	for i := 0; i < n; i++ {
		i := i
		subs[i] = m.Subscribe("k", func(dedup.Result) {
			callbacks[i].Add(1)
		})
		go func() {
			defer barrier.Done()
			if i%3 != 0 {
				subs[i].Cancel()
			}
			<-subs[i].Done()
		}()
	}
	// Complete the upstream concurrently with the cancellations.
	time.Sleep(time.Millisecond)
	close(release)

	barrier.Wait() // barrier: all subscriptions reached a terminal state

	var delivered, cancelled int64
	for i, s := range subs {
		v, err := s.Result()
		switch {
		case errors.Is(err, dedup.ErrCancelled):
			cancelled++
			if c := callbacks[i].Load(); c != 0 {
				t.Fatalf("sub %d: cancelled but callback fired %d times", i, c)
			}
		case err == nil && v == "k-value":
			delivered++
			if c := callbacks[i].Load(); c != 1 {
				t.Fatalf("sub %d: delivered but callback fired %d times", i, c)
			}
		default:
			t.Fatalf("sub %d: unexpected terminal state %v, %v", i, v, err)
		}
	}
	if delivered+cancelled != n {
		t.Fatalf("terminal states = %d, want %d", delivered+cancelled, n)
	}
	t.Logf("delivered=%d cancelled=%d", delivered, cancelled)
}

// TestConcurrentChaos exercises many keys with racing subscribes, cancels,
// and completions under the race detector.
func TestConcurrentChaos(t *testing.T) {
	var starts atomic.Int64
	m := dedup.NewManager(func(ctx context.Context, key string) (any, error) {
		starts.Add(1)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Duration(starts.Load()%3) * time.Millisecond):
			return key, nil
		}
	})

	var wg sync.WaitGroup
	for w := 0; w < 16; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < 100; i++ {
				key := fmt.Sprintf("key-%d", (w+i)%4)
				var fired atomic.Int64
				s := m.Subscribe(key, func(dedup.Result) { fired.Add(1) })
				if (w+i)%2 == 0 {
					s.Cancel()
				}
				<-s.Done()
				_, err := s.Result()
				if errors.Is(err, dedup.ErrCancelled) && fired.Load() != 0 {
					t.Errorf("cancelled sub got %d callbacks", fired.Load())
				}
				if err == nil && fired.Load() != 1 {
					t.Errorf("delivered sub got %d callbacks", fired.Load())
				}
			}
		}(w)
	}
	wg.Wait()
}
