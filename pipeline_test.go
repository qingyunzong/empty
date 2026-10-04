package threepipe

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// double returns a stage that maps v -> v*2.
func double() Stage[int] {
	return func(_ context.Context, v int) (int, error) { return v * 2, nil }
}

// waitFor is a barrier: it fails the test if ch is not closed within d.
func waitFor(t *testing.T, ch <-chan struct{}, d time.Duration, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(d):
		t.Fatalf("timed out waiting for %s", what)
	}
}

// TestOutputOrderMatchesInput forces stages to complete out of order (small
// inputs sleep longest) and checks results still arrive in submission order.
func TestOutputOrderMatchesInput(t *testing.T) {
	const n = 60
	scramble := func(_ context.Context, v int) (int, error) {
		time.Sleep(time.Duration(n-v) * 200 * time.Microsecond)
		return v + 1, nil
	}
	p := New[int](8, 8, scramble, double(), double())

	submitted := make(chan struct{})
	go func() {
		defer close(submitted)
		defer p.Close()
		for i := 0; i < n; i++ {
			if err := p.Submit(context.Background(), i); err != nil {
				t.Errorf("submit %d: %v", i, err)
				return
			}
		}
	}()

	var count int64
	for res := range p.Outputs() {
		if res.Err != nil {
			t.Fatalf("unexpected error for seq %d: %v", res.Seq, res.Err)
		}
		if res.Seq != count {
			t.Fatalf("out of order: got seq %d, want %d", res.Seq, count)
		}
		if want := (int(res.Seq) + 1) * 4; res.Value != want {
			t.Fatalf("seq %d: got value %d, want %d", res.Seq, res.Value, want)
		}
		count++
	}
	waitFor(t, submitted, 5*time.Second, "submitter to finish")
	if count != n {
		t.Fatalf("got %d results, want %d", count, n)
	}
}

// TestPauseBlocksOnlyNewInput verifies that Pause stops new submissions
// while already accepted items keep draining.
func TestPauseBlocksOnlyNewInput(t *testing.T) {
	var entered atomic.Int64 // items that entered stage 1
	counting := func(_ context.Context, v int) (int, error) {
		entered.Add(1)
		return v, nil
	}
	p := New[int](64, 4, counting, double(), double())

	const accepted = 5
	for i := 0; i < accepted; i++ {
		if err := p.Submit(context.Background(), i); err != nil {
			t.Fatalf("submit %d: %v", i, err)
		}
	}
	p.Pause()

	// While paused, new submitters must block.
	var submitted atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func(v int) {
			defer wg.Done()
			if err := p.Submit(context.Background(), v); err != nil {
				t.Errorf("submit %d: %v", v, err)
				return
			}
			submitted.Add(1)
		}(accepted + i)
	}

	// Barrier: accepted items must drain even while paused.
	drained := make(chan struct{})
	go func() {
		defer close(drained)
		for i := 0; i < accepted; i++ {
			res, ok := <-p.Outputs()
			if !ok {
				t.Errorf("output closed early at %d", i)
				return
			}
			if res.Err != nil || res.Seq != int64(i) {
				t.Errorf("bad result %+v at %d", res, i)
			}
		}
	}()
	waitFor(t, drained, 5*time.Second, "accepted items to drain while paused")

	// Counters: no paused submission may have completed or entered stage 1.
	if got := submitted.Load(); got != 0 {
		t.Fatalf("%d submissions completed while paused", got)
	}
	if got := entered.Load(); got != accepted {
		t.Fatalf("stage 1 saw %d items, want %d", got, accepted)
	}

	p.Resume()
	wg.Wait()
	if got := submitted.Load(); got != 5 {
		t.Fatalf("%d submissions completed after resume, want 5", got)
	}
	// Close blocks until accepted items drain, so read concurrently.
	rest := make(chan int64, 1)
	go func() {
		var n int64
		for res := range p.Outputs() {
			if res.Err != nil {
				t.Errorf("unexpected error: %v", res.Err)
				continue
			}
			n++
		}
		rest <- n
	}()
	p.Close()
	if got := <-rest; got != 5 {
		t.Fatalf("got %d results after resume, want 5", got)
	}
}

// TestBackpressureBoundsInFlight starts with no output reader and asserts
// the number of accepted-but-unemitted items never exceeds the limit.
func TestBackpressureBoundsInFlight(t *testing.T) {
	const limit = 3
	const total = 20
	var stage1Entered, emitted atomic.Int64

	first := func(_ context.Context, v int) (int, error) {
		stage1Entered.Add(1)
		return v, nil
	}
	slow := func(_ context.Context, v int) (int, error) {
		time.Sleep(time.Millisecond)
		return v, nil
	}
	p := New[int](limit, 2, first, slow, slow)

	// The first `limit` submissions are accepted without blocking.
	for i := 0; i < limit; i++ {
		if err := p.Submit(context.Background(), i); err != nil {
			t.Fatalf("submit %d: %v", i, err)
		}
	}

	// Further submissions must block: nobody is reading the output and the
	// in-flight limit is reached.
	var extraSubmitted atomic.Int64
	submitterDone := make(chan struct{})
	go func() {
		defer close(submitterDone)
		for i := limit; i < total; i++ {
			if err := p.Submit(context.Background(), i); err != nil {
				t.Errorf("submit %d: %v", i, err)
				return
			}
			extraSubmitted.Add(1)
		}
	}()

	// Barrier: give the submitter ample time to make progress; it must not.
	time.Sleep(100 * time.Millisecond)
	if got := extraSubmitted.Load(); got != 0 {
		t.Fatalf("%d extra submissions accepted beyond the in-flight limit", got)
	}
	// Counter: items inside the stages never exceed the limit while the
	// output is blocked.
	if got := stage1Entered.Load(); got > limit {
		t.Fatalf("%d items entered the stages with a blocked output, limit is %d", got, limit)
	}

	// Start draining; everything must now flow to completion.
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		for range p.Outputs() {
			emitted.Add(1)
		}
	}()
	waitFor(t, submitterDone, 5*time.Second, "submitter to finish after drain starts")
	p.Close()
	waitFor(t, readerDone, 5*time.Second, "reader to finish")
	if got := emitted.Load(); got != total {
		t.Fatalf("emitted %d results, want %d", got, total)
	}
	if got := extraSubmitted.Load(); got != total-limit {
		t.Fatalf("%d extra submissions completed, want %d", got, total-limit)
	}
}

// TestFailureCancelsSuccessorsKeepsPrefix fails one item and checks that the
// emitted prefix is intact, the error is delivered last, and later items are
// cancelled before the final stage.
func TestFailureCancelsSuccessorsKeepsPrefix(t *testing.T) {
	const total = 20
	const failAt = 7
	boom := errors.New("boom")

	var stage3Entered atomic.Int64
	// One worker per stage plus a barrier on the failing item makes the
	// interleaving deterministic: items after failAt queue behind it in
	// stage 2 and cannot slip into stage 3 before the failure lands.
	release := make(chan struct{})
	stage2 := func(_ context.Context, v int) (int, error) {
		if v == failAt {
			<-release
			return 0, boom
		}
		return v, nil
	}
	stage3 := func(_ context.Context, v int) (int, error) {
		stage3Entered.Add(1)
		return v, nil
	}
	identity := func(_ context.Context, v int) (int, error) { return v, nil }
	p := New[int](4, 1, identity, stage2, stage3)

	submitted := make(chan struct{})
	go func() {
		defer close(submitted)
		defer p.Close()
		for i := 0; i < total; i++ {
			err := p.Submit(context.Background(), i)
			if err != nil && !errors.Is(err, ErrFailed) {
				t.Errorf("submit %d: %v", i, err)
				return
			}
		}
	}()

	// Read concurrently from the start: emitting is what frees in-flight
	// slots for later submissions.
	type outcome struct {
		prefix          []int64
		err             error
		resultsAfterErr int64
	}
	readDone := make(chan outcome, 1)
	go func() {
		var o outcome
		for res := range p.Outputs() {
			if res.Err != nil {
				o.err = res.Err
				continue
			}
			if o.err != nil {
				o.resultsAfterErr++
			}
			o.prefix = append(o.prefix, res.Seq)
		}
		readDone <- o
	}()

	// Barrier: fail only once the whole prefix has passed the final stage.
	deadline := time.Now().Add(5 * time.Second)
	for stage3Entered.Load() != failAt {
		if time.Now().After(deadline) {
			t.Fatalf("stage 3 saw %d items, want %d before failure", stage3Entered.Load(), failAt)
		}
		time.Sleep(time.Millisecond)
	}
	close(release)

	o := <-readDone
	waitFor(t, submitted, 5*time.Second, "submitter to finish")

	if !errors.Is(o.err, boom) {
		t.Fatalf("got error %v, want %v", o.err, boom)
	}
	if o.resultsAfterErr != 0 {
		t.Fatalf("%d results emitted after the error", o.resultsAfterErr)
	}
	if len(o.prefix) != failAt {
		t.Fatalf("prefix has %d results, want %d", len(o.prefix), failAt)
	}
	for i, seq := range o.prefix {
		if seq != int64(i) {
			t.Fatalf("prefix broken at %d: got seq %d", i, seq)
		}
	}
	// Counter: only items before the failure may reach the final stage.
	if got := stage3Entered.Load(); got != failAt {
		t.Fatalf("stage 3 saw %d items, want %d (successors not cancelled)", got, failAt)
	}
}

// TestSubmitAfterCloseAndFailure checks terminal-state submit errors.
func TestSubmitAfterCloseAndFailure(t *testing.T) {
	p := New[int](4, 1, double())
	p.Close()
	if err := p.Submit(context.Background(), 1); !errors.Is(err, ErrClosed) {
		t.Fatalf("submit after close: got %v, want ErrClosed", err)
	}
	if _, ok := <-p.Outputs(); ok {
		t.Fatal("output not closed on empty pipeline")
	}

	fail := func(_ context.Context, v int) (int, error) {
		if v == 0 {
			return 0, fmt.Errorf("nope")
		}
		return v, nil
	}
	q := New[int](4, 1, fail)
	if err := q.Submit(context.Background(), 0); err != nil {
		t.Fatalf("submit: %v", err)
	}
	res, ok := <-q.Outputs()
	if !ok || res.Err == nil {
		t.Fatalf("want error result, got %+v ok=%v", res, ok)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		err := q.Submit(context.Background(), 1)
		if errors.Is(err, ErrFailed) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("submit after failure: got %v, want ErrFailed", err)
		}
		time.Sleep(time.Millisecond)
	}
	q.Close()
}
