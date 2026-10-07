package dedup_test

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"dedup/dedup"
)

// barrier verifies the "exactly one terminal state per subscription"
// invariant: every subscription created in a test is assigned a slot, and
// its callback records into that slot. wait blocks until every slot fired
// at least once; check asserts each slot fired exactly once.
type barrier struct {
	mu        sync.Mutex
	counts    []int
	results   []dedup.Result
	remaining int
	allFired  chan struct{}
}

func newBarrier(n int) *barrier {
	return &barrier{
		counts:    make([]int, n),
		results:   make([]dedup.Result, n),
		remaining: n,
		allFired:  make(chan struct{}),
	}
}

func (b *barrier) callback(slot int) func(dedup.Result) {
	return func(r dedup.Result) {
		b.mu.Lock()
		b.counts[slot]++
		b.results[slot] = r
		b.remaining--
		if b.remaining == 0 {
			close(b.allFired)
		}
		b.mu.Unlock()
	}
}

func (b *barrier) wait(t *testing.T) {
	t.Helper()
	select {
	case <-b.allFired:
	case <-time.After(10 * time.Second):
		t.Fatal("barrier: timed out waiting for terminal callbacks")
	}
}

// check asserts every slot reached exactly one terminal state. It waits a
// short grace period first so that a buggy second callback has a chance to
// fire and be detected.
func (b *barrier) check(t *testing.T) {
	t.Helper()
	time.Sleep(50 * time.Millisecond)
	b.mu.Lock()
	defer b.mu.Unlock()
	for i, c := range b.counts {
		if c != 1 {
			t.Errorf("subscription %d: got %d terminal callbacks, want exactly 1", i, c)
		}
	}
}

func (b *barrier) result(slot int) dedup.Result {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.results[slot]
}

// controllable returns a DownloadFunc whose executions are observable and
// gateable, plus counters. Each invocation sends its key on started, then
// blocks until release is closed or ctx is cancelled.
type upstream struct {
	calls   atomic.Int32
	started chan string
	release chan struct{}
}

func newUpstream() *upstream {
	return &upstream{
		started: make(chan string, 64),
		release: make(chan struct{}),
	}
}

func (u *upstream) download(ctx context.Context, key string) (any, error) {
	u.calls.Add(1)
	u.started <- key
	select {
	case <-u.release:
		return "value:" + key, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (u *upstream) waitStarted(t *testing.T) {
	t.Helper()
	select {
	case <-u.started:
	case <-time.After(5 * time.Second):
		t.Fatal("upstream: timed out waiting for download to start")
	}
}

func TestMergesConcurrentSubscribers(t *testing.T) {
	up := newUpstream()
	d := dedup.New(up.download)

	const n = 8
	bar := newBarrier(n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(slot int) {
			defer wg.Done()
			d.Subscribe("k", bar.callback(slot))
		}(i)
	}
	wg.Wait()
	up.waitStarted(t)
	if got := up.calls.Load(); got != 1 {
		t.Fatalf("upstream calls = %d, want 1 (subscriptions must merge)", got)
	}
	close(up.release)

	bar.wait(t)
	bar.check(t)
	for i := 0; i < n; i++ {
		res := bar.result(i)
		if res.Err != nil || res.Value != "value:k" {
			t.Errorf("subscription %d: got %+v, want value:value:k", i, res)
		}
	}
	if got := up.calls.Load(); got != 1 {
		t.Fatalf("upstream calls = %d, want 1", got)
	}
}

func TestCancelOneKeepsUpstreamAlive(t *testing.T) {
	up := newUpstream()
	d := dedup.New(up.download)

	bar := newBarrier(2)
	sub0 := d.Subscribe("k", bar.callback(0))
	d.Subscribe("k", bar.callback(1))
	up.waitStarted(t)

	sub0.Cancel() // not the last subscriber: upstream must keep running
	if got := bar.result(0).Err; !errors.Is(got, dedup.ErrCancelled) {
		t.Fatalf("cancelled subscription: got %v, want ErrCancelled", got)
	}

	close(up.release)
	bar.wait(t)
	bar.check(t)
	if res := bar.result(1); res.Err != nil || res.Value != "value:k" {
		t.Fatalf("surviving subscription: got %+v, want value:value:k", res)
	}
	if got := up.calls.Load(); got != 1 {
		t.Fatalf("upstream calls = %d, want 1", got)
	}
}

func TestLastCancelCancelsUpstream(t *testing.T) {
	up := newUpstream()
	d := dedup.New(up.download)

	bar := newBarrier(2)
	sub0 := d.Subscribe("k", bar.callback(0))
	sub1 := d.Subscribe("k", bar.callback(1))
	up.waitStarted(t)

	sub0.Cancel()
	sub1.Cancel() // last one: must cancel the upstream context

	bar.wait(t) // upstream returned via ctx.Done, no further notifications
	bar.check(t)
	for i := 0; i < 2; i++ {
		if got := bar.result(i).Err; !errors.Is(got, dedup.ErrCancelled) {
			t.Errorf("subscription %d: got %v, want ErrCancelled", i, got)
		}
	}
}

func TestNewSubscriptionCannotJoinCancelledGeneration(t *testing.T) {
	up := newUpstream()
	d := dedup.New(up.download)

	// First generation: subscribed and fully cancelled.
	bar1 := newBarrier(1)
	sub := d.Subscribe("k", bar1.callback(0))
	up.waitStarted(t)
	sub.Cancel()
	bar1.wait(t)
	if got := up.calls.Load(); got != 1 {
		t.Fatalf("upstream calls = %d, want 1", got)
	}

	// The cancelled generation must be retired: a new subscription starts
	// a fresh upstream download instead of joining the dead generation.
	bar2 := newBarrier(1)
	d.Subscribe("k", bar2.callback(0))
	up.waitStarted(t) // second upstream call must actually start
	if got := up.calls.Load(); got != 2 {
		t.Fatalf("upstream calls = %d, want 2 (new generation)", got)
	}
	close(up.release)

	bar2.wait(t)
	bar1.check(t)
	bar2.check(t)
	if res := bar2.result(0); res.Err != nil || res.Value != "value:k" {
		t.Fatalf("new generation: got %+v, want value:value:k", res)
	}
}

func TestUpstreamCompletionNotifiesOnlyActive(t *testing.T) {
	up := newUpstream()
	d := dedup.New(up.download)

	bar := newBarrier(3)
	d.Subscribe("k", bar.callback(0))
	sub1 := d.Subscribe("k", bar.callback(1))
	d.Subscribe("k", bar.callback(2))
	up.waitStarted(t)

	sub1.Cancel() // leaves before completion
	close(up.release)

	bar.wait(t)
	bar.check(t)
	for _, slot := range []int{0, 2} {
		if res := bar.result(slot); res.Err != nil || res.Value != "value:k" {
			t.Errorf("active subscription %d: got %+v, want value:value:k", slot, res)
		}
	}
	if got := bar.result(1).Err; !errors.Is(got, dedup.ErrCancelled) {
		t.Errorf("cancelled subscription: got %v, want ErrCancelled", got)
	}
}

func TestUpstreamErrorReachesActiveSubscribers(t *testing.T) {
	boom := errors.New("boom")
	var calls atomic.Int32
	d := dedup.New(func(ctx context.Context, key string) (any, error) {
		calls.Add(1)
		return nil, boom
	})

	bar := newBarrier(2)
	d.Subscribe("k", bar.callback(0))
	d.Subscribe("k", bar.callback(1))

	bar.wait(t)
	bar.check(t)
	for i := 0; i < 2; i++ {
		if got := bar.result(i).Err; !errors.Is(got, boom) {
			t.Errorf("subscription %d: got %v, want upstream error", i, got)
		}
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("upstream calls = %d, want 1", got)
	}
}

// TestCallbackReentrancy exercises callbacks that re-enter the Deduper:
// one callback subscribes again for the same key, another cancels a live
// subscription of a different key. Neither may deadlock, because callbacks
// run outside the internal lock.
func TestCallbackReentrancy(t *testing.T) {
	gate := make(chan struct{})
	d := dedup.New(func(ctx context.Context, key string) (any, error) {
		if key == "slow" {
			select {
			case <-gate:
				return "slow-value", nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		return "value:" + key, nil
	})

	bar := newBarrier(3)

	// Slot 2: a slow subscription on another key, cancelled re-entrantly
	// from within slot 0's callback.
	slow := d.Subscribe("slow", bar.callback(2))

	// Slot 0: on completion, re-subscribes to the same key (the finished
	// generation is retired, so this starts a new one, slot 1) and
	// cancels the still-live slow subscription.
	d.Subscribe("fast", func(res dedup.Result) {
		if res.Err != nil {
			t.Errorf("fast subscription: unexpected error %v", res.Err)
		}
		// Re-entrant subscribe: must not deadlock.
		d.Subscribe("fast", bar.callback(1))
		// Re-entrant cancel of a still-live subscription.
		slow.Cancel()
		bar.callback(0)(res)
	})

	bar.wait(t)
	bar.check(t)
	if res := bar.result(1); res.Err != nil || res.Value != "value:fast" {
		t.Errorf("re-entrant subscription: got %+v, want value:value:fast", res)
	}
	if got := bar.result(2).Err; !errors.Is(got, dedup.ErrCancelled) {
		t.Errorf("re-entrantly cancelled subscription: got %v, want ErrCancelled", got)
	}
	close(gate)
}

// TestStressExactlyOneTerminal hammers the Deduper with concurrent
// subscribes and cancels across a few keys, then uses the barrier to
// verify every subscription reached exactly one terminal state.
func TestStressExactlyOneTerminal(t *testing.T) {
	d := dedup.New(func(ctx context.Context, key string) (any, error) {
		select {
		case <-time.After(time.Duration(rand.Intn(3)) * time.Millisecond):
			return "value:" + key, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	})

	const n = 400
	bar := newBarrier(n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(slot int) {
			defer wg.Done()
			key := fmt.Sprintf("key-%d", slot%4)
			sub := d.Subscribe(key, bar.callback(slot))
			if rand.Intn(2) == 0 {
				time.Sleep(time.Duration(rand.Intn(2)) * time.Millisecond)
				sub.Cancel()
			}
		}(i)
	}
	wg.Wait()

	bar.wait(t)
	bar.check(t)
	for i := 0; i < n; i++ {
		res := bar.result(i)
		if res.Err != nil && !errors.Is(res.Err, dedup.ErrCancelled) {
			t.Errorf("subscription %d: unexpected terminal error %v", i, res.Err)
		}
	}
}

// TestResultBlocksUntilTerminal covers the Done/Result accessors.
func TestResultBlocksUntilTerminal(t *testing.T) {
	up := newUpstream()
	d := dedup.New(up.download)

	sub := d.Subscribe("k", nil) // nil callback: observe via Result
	up.waitStarted(t)
	select {
	case <-sub.Done():
		t.Fatal("Done closed before upstream completed")
	default:
	}
	close(up.release)
	if res := sub.Result(); res.Err != nil || res.Value != "value:k" {
		t.Fatalf("Result = %+v, want value:value:k", res)
	}
}
