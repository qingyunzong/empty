package pipeline

import (
	"context"
	"errors"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// barrier blocks every caller of arrive until n callers have arrived,
// then releases all of them at once.
type barrier struct {
	n       int32
	arrived int32
	ch      chan struct{}
}

func newBarrier(n int) *barrier {
	return &barrier{n: int32(n), ch: make(chan struct{})}
}

func (b *barrier) arrive() {
	if atomic.AddInt32(&b.arrived, 1) == b.n {
		close(b.ch)
	}
	<-b.ch
}

// collector drains an output channel in the background and records how
// many values it received.
type collector struct {
	mu    sync.Mutex
	vals  []any
	count int32 // atomic mirror of len(vals)
}

func collect(out <-chan any) *collector {
	c := &collector{}
	go func() {
		for v := range out {
			c.mu.Lock()
			c.vals = append(c.vals, v)
			c.mu.Unlock()
			atomic.AddInt32(&c.count, 1)
		}
	}()
	return c
}

func (c *collector) snapshot() []any {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]any(nil), c.vals...)
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s", what)
}

func pass(ctx context.Context, v any) (any, error) { return v, nil }

// TestOrderedOutputWithOutOfOrderStages verifies that results are
// emitted in input order even though stage workers complete items out
// of order, and that stages really run concurrently.
func TestOrderedOutputWithOutOfOrderStages(t *testing.T) {
	const n = 24
	var mu sync.Mutex
	var stage1Done []int
	var inFlight, maxSeen int32

	s1 := func(ctx context.Context, v any) (any, error) {
		cur := atomic.AddInt32(&inFlight, 1)
		for {
			old := atomic.LoadInt32(&maxSeen)
			if cur <= old || atomic.CompareAndSwapInt32(&maxSeen, old, cur) {
				break
			}
		}
		defer atomic.AddInt32(&inFlight, -1)
		seq := v.(int)
		// Smaller seqs sleep longer, so stage 1 finishes items in
		// (roughly) reverse input order.
		time.Sleep(time.Duration(n-seq) * time.Millisecond)
		mu.Lock()
		stage1Done = append(stage1Done, seq)
		mu.Unlock()
		return v, nil
	}
	s2 := pass
	s3 := func(ctx context.Context, v any) (any, error) { return v.(int) * 2, nil }

	p, err := New(4, 8, s1, s2, s3)
	if err != nil {
		t.Fatal(err)
	}
	in := make(chan any, n)
	for i := 0; i < n; i++ {
		in <- i
	}
	close(in)
	out := make(chan any, n)

	if err := p.Run(context.Background(), in, out); err != nil {
		t.Fatalf("Run: %v", err)
	}
	close(out)
	var got []any
	for v := range out {
		got = append(got, v)
	}
	if len(got) != n {
		t.Fatalf("got %d results, want %d", len(got), n)
	}
	for i, v := range got {
		if v.(int) != i*2 {
			t.Fatalf("position %d: got %v, want %d", i, v, i*2)
		}
	}
	inOrder := len(stage1Done) == n
	for i := 1; i < len(stage1Done); i++ {
		if stage1Done[i] < stage1Done[i-1] {
			inOrder = false
		}
	}
	if inOrder {
		t.Fatalf("stage 1 completed in input order, out-of-order completion not exercised: %v", stage1Done)
	}
	if got := atomic.LoadInt32(&maxSeen); got < 2 {
		t.Fatalf("stage 1 max concurrency = %d, want >= 2", got)
	}
}

// TestPauseBlocksNewInputAndDrains verifies that Pause stops the
// acceptor from receiving new input while already-accepted items keep
// draining to the output.
func TestPauseBlocksNewInputAndDrains(t *testing.T) {
	var entered, sent int32
	gate := newBarrier(4) // holds the first 4 items inside stage 1
	released := make(chan struct{})

	s1 := func(ctx context.Context, v any) (any, error) {
		atomic.AddInt32(&entered, 1)
		gate.arrive()
		<-released
		return v, nil
	}
	p, err := New(4, 4, s1, pass, pass)
	if err != nil {
		t.Fatal(err)
	}
	in := make(chan any)
	out := make(chan any)
	c := collect(out)

	runDone := make(chan error, 1)
	go func() { runDone <- p.Run(context.Background(), in, out) }()

	// Feeder sends exactly 6 items, then closes the input.
	go func() {
		for i := 0; i < 6; i++ {
			in <- i
			atomic.AddInt32(&sent, 1)
		}
		close(in)
	}()

	// Four items are accepted and held inside stage 1.
	waitFor(t, "4 items entered stage 1", func() bool { return atomic.LoadInt32(&entered) == 4 })

	// Pause is synchronous: once it returns, no new input is received.
	if err := p.Pause(); err != nil {
		t.Fatalf("Pause: %v", err)
	}

	// The 4 accepted items must drain to the output while paused.
	close(released)
	waitFor(t, "accepted items drained while paused", func() bool {
		return atomic.LoadInt32(&c.count) == 4
	})

	// While paused, the feeder must not hand over any new item.
	time.Sleep(100 * time.Millisecond)
	if got := atomic.LoadInt32(&sent); got != 4 {
		t.Fatalf("feeder sent %d items while paused, want 4", got)
	}
	if got := atomic.LoadInt32(&entered); got != 4 {
		t.Fatalf("%d items entered stage 1 while paused, want 4", got)
	}

	// Resume lets the remaining input through.
	if err := p.Resume(); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	waitFor(t, "remaining input accepted after resume", func() bool {
		return atomic.LoadInt32(&sent) == 6
	})
	if err := <-runDone; err != nil {
		t.Fatalf("Run: %v", err)
	}
	waitFor(t, "all items emitted", func() bool { return atomic.LoadInt32(&c.count) == 6 })
	for i, v := range c.snapshot() {
		if v.(int) != i {
			t.Fatalf("position %d: got %v, want %d", i, v, i)
		}
	}
}

// TestInFlightBoundWithBlockedOutput verifies that the number of
// accepted-but-not-yet-emitted items never exceeds maxInFlight, even
// while the output channel is blocked.
func TestInFlightBoundWithBlockedOutput(t *testing.T) {
	const maxInFlight = 3
	const total = 6
	var sent, emitted, entered int32
	gate := make(chan struct{}) // holds the first 2 items inside stage 1

	s1 := func(ctx context.Context, v any) (any, error) {
		if atomic.AddInt32(&entered, 1) <= 2 {
			<-gate
		}
		return v, nil
	}
	p, err := New(2, maxInFlight, s1, pass, pass)
	if err != nil {
		t.Fatal(err)
	}
	in := make(chan any)
	out := make(chan any) // unbuffered: output blocks until the test reads

	runDone := make(chan error, 1)
	go func() { runDone <- p.Run(context.Background(), in, out) }()
	go func() {
		for i := 0; i < total; i++ {
			in <- i
			atomic.AddInt32(&sent, 1)
		}
		close(in)
	}()

	// Background sampler: in-flight = accepted (sent) - emitted must
	// never exceed maxInFlight.
	var maxObserved int32
	samplerStop := make(chan struct{})
	var samplerDone sync.WaitGroup
	samplerDone.Add(1)
	go func() {
		defer samplerDone.Done()
		for {
			select {
			case <-samplerStop:
				return
			default:
			}
			cur := atomic.LoadInt32(&sent) - atomic.LoadInt32(&emitted)
			for {
				old := atomic.LoadInt32(&maxObserved)
				if cur <= old || atomic.CompareAndSwapInt32(&maxObserved, old, cur) {
					break
				}
			}
			time.Sleep(time.Millisecond)
		}
	}()

	// Two items are held in stage 1, one sits in the internal buffer:
	// the pipeline is full and the 4th send must block.
	waitFor(t, "2 items entered stage 1", func() bool { return atomic.LoadInt32(&entered) == 2 })
	waitFor(t, "3 items accepted", func() bool { return atomic.LoadInt32(&sent) == 3 })
	time.Sleep(100 * time.Millisecond)
	if got := atomic.LoadInt32(&sent); got != maxInFlight {
		t.Fatalf("accepted %d items with blocked output, want <= %d", got, maxInFlight)
	}

	// Unblock stage 1 and read the output; every read frees a slot.
	close(gate)
	for i := 0; i < total; i++ {
		select {
		case v := <-out:
			if v.(int) != i {
				t.Fatalf("position %d: got %v, want %d", i, v, i)
			}
			atomic.AddInt32(&emitted, 1)
		case <-time.After(5 * time.Second):
			t.Fatalf("timeout reading item %d", i)
		}
	}
	if err := <-runDone; err != nil {
		t.Fatalf("Run: %v", err)
	}
	close(samplerStop)
	samplerDone.Wait()
	if got := atomic.LoadInt32(&maxObserved); got > maxInFlight {
		t.Fatalf("max in-flight observed = %d, want <= %d", got, maxInFlight)
	}
}

// TestFailureCancelsSubsequentPreservesPrefix verifies that a stage
// failure cancels subsequent items, preserves the already-emitted
// prefix and makes Run return the earliest failure.
func TestFailureCancelsSubsequentPreservesPrefix(t *testing.T) {
	boom := errors.New("boom")
	item4Started := make(chan struct{})
	var item4Cancelled int32

	s1 := func(ctx context.Context, v any) (any, error) { return v.(int) + 100, nil }
	s2 := func(ctx context.Context, v any) (any, error) {
		switch v.(int) {
		case 103: // item 3 fails, but only once item 4 is in flight
			<-item4Started
			return nil, boom
		case 104: // item 4 must observe cancellation
			close(item4Started)
			<-ctx.Done()
			atomic.AddInt32(&item4Cancelled, 1)
			return nil, ctx.Err()
		}
		return v.(int) + 20, nil
	}
	s3 := func(ctx context.Context, v any) (any, error) { return v.(int) + 3, nil }

	p, err := New(2, 4, s1, s2, s3)
	if err != nil {
		t.Fatal(err)
	}
	in := make(chan any, 10)
	for i := 0; i < 10; i++ {
		in <- i
	}
	close(in)
	out := make(chan any)
	c := collect(out)

	runErr := p.Run(context.Background(), in, out)
	if !errors.Is(runErr, boom) {
		t.Fatalf("Run error = %v, want %v", runErr, boom)
	}
	waitFor(t, "prefix emitted", func() bool { return atomic.LoadInt32(&c.count) == 3 })
	got := c.snapshot()
	want := []any{123, 124, 125} // items 0,1,2 after +100, +20, +3
	if len(got) != len(want) {
		t.Fatalf("emitted %v, want prefix %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("emitted %v, want prefix %v", got, want)
		}
	}
	// The prefix must survive: no further output may appear.
	time.Sleep(100 * time.Millisecond)
	if got := atomic.LoadInt32(&c.count); got != 3 {
		t.Fatalf("got %d outputs after failure, want exactly the 3-item prefix", got)
	}
	if atomic.LoadInt32(&item4Cancelled) != 1 {
		t.Fatal("item 4 did not observe cancellation")
	}
}

// TestContextCancellation verifies that cancelling the run context
// aborts the run and does not leak goroutines.
func TestContextCancellation(t *testing.T) {
	before := runtime.NumGoroutine()

	s1 := func(ctx context.Context, v any) (any, error) {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(10 * time.Second):
			return v, nil
		}
	}
	p, err := New(2, 4, s1, pass, pass)
	if err != nil {
		t.Fatal(err)
	}
	in := make(chan any, 8)
	for i := 0; i < 8; i++ {
		in <- i
	}
	defer close(in)
	out := make(chan any)
	c := collect(out)
	_ = c

	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan error, 1)
	go func() { runDone <- p.Run(ctx, in, out) }()
	time.Sleep(50 * time.Millisecond)
	cancel()
	select {
	case err := <-runDone:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Run error = %v, want context.Canceled", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after context cancellation")
	}

	waitFor(t, "goroutines to settle", func() bool {
		return runtime.NumGoroutine() <= before+1
	})
}
