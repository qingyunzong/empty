package quota

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"
)

// waitFor polls cond until it holds or the deadline passes.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func acquireAsync(ctx context.Context, p *Pool, req Resources) <-chan struct {
	tok *Token
	err error
} {
	ch := make(chan struct {
		tok *Token
		err error
	}, 1)
	go func() {
		tk, e := p.Acquire(ctx, req)
		ch <- struct {
			tok *Token
			err error
		}{tk, e}
	}()
	return ch
}

// verifyLog replays the event log and checks the linearization invariants:
//   - Seq is a dense total order starting at 0;
//   - usage after every event is within [0, capacity] and matches the
//     recorded Used snapshot (resource conservation);
//   - every token is granted at most once and released at most once, and a
//     release always matches a prior grant;
//   - a queued waiter is granted only when it is the oldest pending waiter
//     (strict FIFO, no overtaking);
//   - a fast-path grant (no enqueue) happens only while the queue is empty.
func verifyLog(t *testing.T, capacity Resources, events []Event) {
	t.Helper()
	used := Resources{}
	live := map[int64]bool{} // granted and not yet released
	var pending []int64      // enqueued, neither granted nor canceled
	inPending := func(id int64) int {
		for i, x := range pending {
			if x == id {
				return i
			}
		}
		return -1
	}
	for i, e := range events {
		if e.Seq != int64(i) {
			t.Fatalf("event %d: seq = %d, want dense order", i, e.Seq)
		}
		switch e.Kind {
		case EventEnqueue:
			if inPending(e.ID) >= 0 {
				t.Fatalf("event %d: waiter %d enqueued twice", i, e.ID)
			}
			pending = append(pending, e.ID)
		case EventCancel:
			idx := inPending(e.ID)
			if idx < 0 {
				t.Fatalf("event %d: cancel of non-pending waiter %d", i, e.ID)
			}
			pending = append(pending[:idx], pending[idx+1:]...)
		case EventGrant:
			if live[e.ID] {
				t.Fatalf("event %d: token %d granted while still live", i, e.ID)
			}
			if idx := inPending(e.ID); idx >= 0 {
				if idx != 0 {
					t.Fatalf("event %d: waiter %d granted over %d older waiter(s) (FIFO violation)", i, e.ID, idx)
				}
				pending = pending[1:]
			} else if len(pending) > 0 {
				t.Fatalf("event %d: fast-path grant %d while queue non-empty", i, e.ID)
			}
			live[e.ID] = true
			used.add(e.Req)
		case EventRelease:
			if !live[e.ID] {
				t.Fatalf("event %d: duplicate or unmatched release of token %d", i, e.ID)
			}
			delete(live, e.ID)
			used.sub(e.Req)
		}
		if used.CPU < 0 || used.Mem < 0 {
			t.Fatalf("event %d (%s %d): negative usage %+v", i, e.Kind, e.ID, used)
		}
		if !used.fitsIn(capacity) {
			t.Fatalf("event %d (%s %d): usage %+v exceeds capacity %+v", i, e.Kind, e.ID, used, capacity)
		}
		if e.Used != used {
			t.Fatalf("event %d (%s %d): recorded used %+v, replayed %+v", i, e.Kind, e.ID, e.Used, used)
		}
	}
}

// TestHeadOfLineBlocking builds the classic head-of-line scenario: a big
// waiter at the head must block a smaller waiter behind it that would fit on
// its own, and once the blocker clears, grants must happen in FIFO order.
func TestHeadOfLineBlocking(t *testing.T) {
	p := NewPool(Resources{CPU: 4, Mem: 4})
	ctx := context.Background()

	big, err := p.Acquire(ctx, Resources{CPU: 3, Mem: 3})
	if err != nil {
		t.Fatalf("initial acquire: %v", err)
	}

	headCh := acquireAsync(ctx, p, Resources{CPU: 2, Mem: 2}) // does not fit alongside big
	// Make sure the head waiter is enqueued before the tail request arrives,
	// otherwise the tail could slip through the fast path on an empty queue.
	waitFor(t, "head waiter queued", func() bool {
		_, _, queued := p.Stats()
		return queued == 1
	})
	tailCh := acquireAsync(ctx, p, Resources{CPU: 1, Mem: 1}) // would fit, but queued behind head
	waitFor(t, "two queued waiters", func() bool {
		_, _, queued := p.Stats()
		return queued == 2
	})

	// The tail request fits in the remaining {1,1}, but strict FIFO forbids
	// overtaking: nothing may be granted while the head is blocked.
	select {
	case r := <-tailCh:
		t.Fatalf("tail request overtook blocked head: got token %v, err %v", r.tok, r.err)
	case <-time.After(100 * time.Millisecond):
	}
	for _, e := range p.Events() {
		if e.Kind == EventGrant && e.ID != big.id {
			t.Fatalf("grant %+v committed while head of queue was blocked", e)
		}
	}

	// Freeing the big token unblocks the queue; grants must follow FIFO order.
	big.Release()

	head := <-headCh
	if head.err != nil {
		t.Fatalf("head acquire: %v", head.err)
	}
	tail := <-tailCh
	if tail.err != nil {
		t.Fatalf("tail acquire: %v", tail.err)
	}
	if head.tok.id >= tail.tok.id {
		t.Fatalf("grant order violated FIFO: head id %d, tail id %d", head.tok.id, tail.tok.id)
	}

	used, _, queued := p.Stats()
	if want := (Resources{CPU: 3, Mem: 3}); used != want || queued != 0 {
		t.Fatalf("after unblocking: used=%+v queued=%d, want used=%+v queued=0", used, queued, want)
	}

	head.tok.Release()
	tail.tok.Release()
	waitFor(t, "pool drained", func() bool {
		u, _, q := p.Stats()
		return u == Resources{} && q == 0
	})
	verifyLog(t, Resources{CPU: 4, Mem: 4}, p.Events())
}

// TestDuplicateRelease hammers a token with sequential and concurrent
// releases and checks that resources are returned exactly once.
func TestDuplicateRelease(t *testing.T) {
	p := NewPool(Resources{CPU: 2, Mem: 2})
	tok, err := p.Acquire(context.Background(), Resources{CPU: 2, Mem: 2})
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}

	tok.Release()
	tok.Release() // sequential duplicate

	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			tok.Release() // concurrent duplicates
		}()
	}
	wg.Wait()

	used, _, _ := p.Stats()
	if used != (Resources{}) {
		t.Fatalf("used = %+v after duplicate releases, want zero", used)
	}

	// The pool must be fully reusable: a request for the whole capacity is
	// granted immediately, proving no phantom usage leaked.
	tok2, err := p.Acquire(context.Background(), Resources{CPU: 2, Mem: 2})
	if err != nil {
		t.Fatalf("re-acquire of full capacity: %v", err)
	}
	tok2.Release()

	releases := 0
	for _, e := range p.Events() {
		if e.Kind == EventRelease && e.ID == tok.id {
			releases++
		}
	}
	if releases != 1 {
		t.Fatalf("token %d released %d times in event log, want exactly 1", tok.id, releases)
	}
	verifyLog(t, Resources{CPU: 2, Mem: 2}, p.Events())
}

// TestCancelGrantRace races cancellation against granting many times. Each
// round must have exactly one winner, and all resources must be conserved.
func TestCancelGrantRace(t *testing.T) {
	const rounds = 200
	p := NewPool(Resources{CPU: 1, Mem: 1})
	var grants, cancels int

	for i := 0; i < rounds; i++ {
		holder, err := p.Acquire(context.Background(), Resources{CPU: 1, Mem: 1})
		if err != nil {
			t.Fatalf("round %d: holder acquire: %v", i, err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		resCh := acquireAsync(ctx, p, Resources{CPU: 1, Mem: 1})
		waitFor(t, "waiter queued", func() bool {
			_, _, q := p.Stats()
			return q == 1
		})

		// Fire the release and the cancellation at (nearly) the same time.
		go holder.Release()
		go cancel()

		res := <-resCh
		if res.err != nil {
			if res.err != context.Canceled {
				t.Fatalf("round %d: unexpected error %v", i, res.err)
			}
			if res.tok != nil {
				t.Fatalf("round %d: canceled acquire returned a token", i)
			}
			cancels++
		} else {
			// The grant won the race inside the lock; the caller owns the
			// token and must release it.
			grants++
			res.tok.Release()
		}
		waitFor(t, "pool drained", func() bool {
			u, _, q := p.Stats()
			return u == Resources{} && q == 0
		})
	}
	if grants == 0 || cancels == 0 {
		t.Fatalf("race not exercised: grants=%d cancels=%d", grants, cancels)
	}
	t.Logf("race outcomes over %d rounds: %d grants, %d cancels", rounds, grants, cancels)
	verifyLog(t, Resources{CPU: 1, Mem: 1}, p.Events())
}

// TestConservationUnderChaos runs many goroutines doing random
// acquire/cancel/release (with occasional duplicate releases) and verifies
// resource conservation and log linearizability at the end.
func TestConservationUnderChaos(t *testing.T) {
	capacity := Resources{CPU: 8, Mem: 16}
	p := NewPool(capacity)

	var wg sync.WaitGroup
	for g := 0; g < 32; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			seed := int64(g)*7919 + 13
			rnd := func(n int64) int64 {
				seed = seed*6364136223846793005 + 1442695040888963407
				return (seed >> 33) % n
			}
			for i := 0; i < 50; i++ {
				req := Resources{CPU: 1 + rnd(4), Mem: 1 + rnd(8)}
				ctx, cancel := context.WithTimeout(context.Background(), time.Duration(rnd(20))*time.Millisecond)
				tok, err := p.Acquire(ctx, req)
				cancel()
				if err != nil {
					continue
				}
				time.Sleep(time.Duration(rnd(3)) * time.Millisecond)
				tok.Release()
				if rnd(4) == 0 {
					tok.Release() // duplicate release must be a no-op
				}
			}
		}(g)
	}
	wg.Wait()

	waitFor(t, "pool drained", func() bool {
		u, _, q := p.Stats()
		return u == Resources{} && q == 0
	})
	verifyLog(t, capacity, p.Events())
}

// TestOversizeRejected checks that requests that can never fit fail fast
// instead of blocking the queue forever.
func TestOversizeRejected(t *testing.T) {
	p := NewPool(Resources{CPU: 2, Mem: 2})
	if _, err := p.Acquire(context.Background(), Resources{CPU: 3, Mem: 1}); err != ErrOversize {
		t.Fatalf("cpu oversize: err = %v, want ErrOversize", err)
	}
	if _, err := p.Acquire(context.Background(), Resources{CPU: 1, Mem: 3}); err != ErrOversize {
		t.Fatalf("mem oversize: err = %v, want ErrOversize", err)
	}
	if _, err := p.Acquire(context.Background(), Resources{CPU: -1, Mem: 1}); err != ErrNegative {
		t.Fatalf("negative: err = %v, want ErrNegative", err)
	}
}

// Example demonstrates a job acquiring CPU and memory atomically.
func Example() {
	p := NewPool(Resources{CPU: 4, Mem: 8})
	tok, err := p.Acquire(context.Background(), Resources{CPU: 2, Mem: 4})
	if err != nil {
		panic(err)
	}
	defer tok.Release()
	used, cap, _ := p.Stats()
	fmt.Printf("using %v of %v\n", used, cap)
	// Output: using {2 4} of {4 8}
}
