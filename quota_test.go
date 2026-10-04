package quota

import (
	"context"
	"sync"
	"testing"
	"time"
)

type acquireResult struct {
	tok *Token
	err error
}

func acquireAsync(p *Pool, ctx context.Context, cpu, mem int64) <-chan acquireResult {
	ch := make(chan acquireResult, 1)
	go func() {
		tok, err := p.Acquire(ctx, cpu, mem)
		ch <- acquireResult{tok, err}
	}()
	return ch
}

func mustNotGrant(t *testing.T, name string, ch <-chan acquireResult, d time.Duration) {
	t.Helper()
	select {
	case r := <-ch:
		t.Fatalf("%s: unexpectedly granted (tok=%v err=%v)", name, r.tok, r.err)
	case <-time.After(d):
	}
}

func mustGrant(t *testing.T, name string, ch <-chan acquireResult) *Token {
	t.Helper()
	select {
	case r := <-ch:
		if r.err != nil {
			t.Fatalf("%s: unexpected error: %v", name, r.err)
		}
		return r.tok
	case <-time.After(2 * time.Second):
		t.Fatalf("%s: timed out waiting for grant", name)
	}
	return nil
}

// waitEnqueued blocks until the request with the given ID appears in the
// linearized event log, removing enqueue-order races between goroutines.
func waitEnqueued(t *testing.T, p *Pool, id uint64) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		for _, e := range p.Events() {
			if e.Kind == EventEnqueued && e.ReqID == id {
				return
			}
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("req %d was not enqueued in time", id)
}

// Head-of-line blocking: a head request that does not fit must block later,
// smaller requests even when they would fit in the remaining capacity.
func TestHeadOfLineBlocking(t *testing.T) {
	p := NewPool(4, 4)

	tokA, err := p.Acquire(context.Background(), 2, 2)
	if err != nil {
		t.Fatalf("A: %v", err)
	}

	bCh := acquireAsync(p, context.Background(), 3, 3) // head, does not fit in 2/2 remaining
	waitEnqueued(t, p, 1)                              // B must be head before C enqueues
	cCh := acquireAsync(p, context.Background(), 1, 1) // fits in 2/2, but must not overtake
	waitEnqueued(t, p, 2)

	mustNotGrant(t, "B", bCh, 50*time.Millisecond)
	mustNotGrant(t, "C", cCh, 50*time.Millisecond)

	tokA.Release()

	tokB := mustGrant(t, "B", bCh)
	tokC := mustGrant(t, "C", cCh) // after B takes 3/3, exactly 1/1 remains for C

	// Grant order in the linearized log must be B before C.
	var grantOrder []uint64
	for _, e := range p.Events() {
		if e.Kind == EventGranted {
			grantOrder = append(grantOrder, e.ReqID)
		}
	}
	// ReqIDs: A=0, B=1, C=2
	if len(grantOrder) != 3 || grantOrder[0] != 0 || grantOrder[1] != 1 || grantOrder[2] != 2 {
		t.Fatalf("grant order = %v, want [0 1 2]", grantOrder)
	}

	tokB.Release()
	tokC.Release()
	if cpu, mem := p.Used(); cpu != 0 || mem != 0 {
		t.Fatalf("used = (%d,%d), want (0,0)", cpu, mem)
	}
}

// Duplicate release: concurrent releases of one token must be idempotent
// and must not leak or double-return capacity.
func TestDuplicateRelease(t *testing.T) {
	p := NewPool(2, 2)
	tok, err := p.Acquire(context.Background(), 1, 1)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}

	const releasers = 32
	var wg sync.WaitGroup
	for i := 0; i < releasers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			tok.Release()
		}()
	}
	wg.Wait()
	tok.Release() // one more for good measure

	if cpu, mem := p.Used(); cpu != 0 || mem != 0 {
		t.Fatalf("used = (%d,%d), want (0,0): release not idempotent", cpu, mem)
	}

	releases := 0
	for _, e := range p.Events() {
		if e.Kind == EventReleased {
			releases++
		}
	}
	if releases != 1 {
		t.Fatalf("release events = %d, want exactly 1", releases)
	}

	// Full capacity must still be available.
	full, err := p.Acquire(context.Background(), 2, 2)
	if err != nil {
		t.Fatalf("re-acquire full capacity: %v", err)
	}
	full.Release()
}

// Cancel while queued behind a blocked head: the request must be removed
// and never hold resources; the queue must keep making progress.
func TestCancelWhileQueued(t *testing.T) {
	p := NewPool(1, 1)
	holder, err := p.Acquire(context.Background(), 1, 1)
	if err != nil {
		t.Fatalf("holder: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	waiterCh := acquireAsync(p, ctx, 1, 1)
	waitEnqueued(t, p, 1)
	mustNotGrant(t, "waiter", waiterCh, 20*time.Millisecond)
	cancel()

	select {
	case r := <-waiterCh:
		if r.err != context.Canceled {
			t.Fatalf("waiter err = %v, want context.Canceled", r.err)
		}
		if r.tok != nil {
			t.Fatalf("canceled waiter returned a token")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("canceled waiter did not return")
	}

	// A later request must still be served once capacity frees up.
	nextCh := acquireAsync(p, context.Background(), 1, 1)
	mustNotGrant(t, "next", nextCh, 20*time.Millisecond)
	holder.Release()
	next := mustGrant(t, "next", nextCh)
	next.Release()

	// The canceled request must have exactly one terminal event: canceled.
	terminal := map[EventKind]int{}
	for _, e := range p.Events() {
		if e.ReqID == 1 && (e.Kind == EventGranted || e.Kind == EventCanceled) {
			terminal[e.Kind]++
		}
	}
	if terminal[EventCanceled] != 1 || terminal[EventGranted] != 0 {
		t.Fatalf("canceled req terminal events = %v", terminal)
	}
}

// Cancel vs grant: the race is decided by lock order. Either way the
// outcome must be consistent: error means no resources held, token means
// resources held (and reclaimable via Release). No leaks across many races.
func TestCancelGrantRace(t *testing.T) {
	for i := 0; i < 2000; i++ {
		p := NewPool(1, 1)
		holder, err := p.Acquire(context.Background(), 1, 1)
		if err != nil {
			t.Fatalf("holder: %v", err)
		}

		ctx, cancel := context.WithCancel(context.Background())
		waiterCh := acquireAsync(p, ctx, 1, 1)

		// Fire release and cancel concurrently to race grant vs cancel.
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); holder.Release() }()
		go func() { defer wg.Done(); cancel() }()
		wg.Wait()

		r := <-waiterCh
		if r.err != nil {
			if r.tok != nil {
				t.Fatal("error and token both returned")
			}
		} else {
			r.tok.Release()
		}
		if cpu, mem := p.Used(); cpu != 0 || mem != 0 {
			t.Fatalf("iter %d: used = (%d,%d), want (0,0): leak across cancel/grant race", i, cpu, mem)
		}
	}
}

// Conservation + linearization: hammer the pool concurrently, then replay
// the event log verifying (a) usage never exceeds capacity or goes negative
// at any linearization point, (b) event snapshots match the replayed state,
// (c) every request has exactly one terminal event, (d) all granted quota
// is eventually released exactly once.
func TestConservationAndLinearization(t *testing.T) {
	const (
		totalCPU = 8
		totalMem = 16
		workers  = 16
		opsPerW  = 200
	)
	p := NewPool(totalCPU, totalMem)

	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < opsPerW; i++ {
				cpu := int64((w+i)%3 + 1) // 1..3
				mem := int64((w*2+i)%4 + 1)
				var ctx context.Context
				var cancel context.CancelFunc
				if (w+i)%5 == 0 {
					ctx, cancel = context.WithTimeout(context.Background(), time.Duration((w+i)%7)*time.Millisecond)
				} else {
					ctx, cancel = context.WithCancel(context.Background())
				}
				tok, err := p.Acquire(ctx, cpu, mem)
				cancel()
				if err != nil {
					continue
				}
				tok.Release()
				tok.Release() // duplicate release must be a no-op
			}
		}(w)
	}
	wg.Wait()

	if cpu, mem := p.Used(); cpu != 0 || mem != 0 {
		t.Fatalf("final used = (%d,%d), want (0,0)", cpu, mem)
	}

	events := p.Events()
	for i, e := range events {
		if e.Seq != uint64(i) {
			t.Fatalf("event %d has seq %d: log is not a contiguous linearization", i, e.Seq)
		}
	}

	var usedCPU, usedMem int64
	terminal := map[uint64]EventKind{}
	released := map[uint64]int{}
	for _, e := range events {
		switch e.Kind {
		case EventEnqueued:
			if _, ok := terminal[e.ReqID]; ok {
				t.Fatalf("req %d enqueued after terminal event", e.ReqID)
			}
		case EventGranted:
			if _, ok := terminal[e.ReqID]; ok {
				t.Fatalf("req %d granted twice or after cancel", e.ReqID)
			}
			terminal[e.ReqID] = EventGranted
			usedCPU += e.CPU
			usedMem += e.Mem
		case EventCanceled:
			if _, ok := terminal[e.ReqID]; ok {
				t.Fatalf("req %d canceled twice or after grant", e.ReqID)
			}
			terminal[e.ReqID] = EventCanceled
		case EventReleased:
			if terminal[e.ReqID] != EventGranted {
				t.Fatalf("req %d released without grant", e.ReqID)
			}
			released[e.ReqID]++
			if released[e.ReqID] > 1 {
				t.Fatalf("req %d released more than once", e.ReqID)
			}
			usedCPU -= e.CPU
			usedMem -= e.Mem
		}
		if usedCPU < 0 || usedMem < 0 {
			t.Fatalf("negative usage at seq %d: (%d,%d)", e.Seq, usedCPU, usedMem)
		}
		if usedCPU > totalCPU || usedMem > totalMem {
			t.Fatalf("capacity exceeded at seq %d: (%d,%d) > (%d,%d)", e.Seq, usedCPU, usedMem, totalCPU, totalMem)
		}
		if e.UsedCPU != usedCPU || e.UsedMem != usedMem {
			t.Fatalf("seq %d: snapshot (%d,%d) != replayed (%d,%d)", e.Seq, e.UsedCPU, e.UsedMem, usedCPU, usedMem)
		}
	}
	if usedCPU != 0 || usedMem != 0 {
		t.Fatalf("replayed final usage = (%d,%d), want (0,0)", usedCPU, usedMem)
	}
	for id, kind := range terminal {
		if kind == EventGranted && released[id] != 1 {
			t.Fatalf("granted req %d released %d times, want 1", id, released[id])
		}
	}
}

// Unsatisfiable requests fail fast without poisoning the queue.
func TestInvalidRequest(t *testing.T) {
	p := NewPool(2, 2)
	if _, err := p.Acquire(context.Background(), 3, 1); err != ErrInvalidRequest {
		t.Fatalf("oversized cpu: err = %v", err)
	}
	if _, err := p.Acquire(context.Background(), 1, -1); err != ErrInvalidRequest {
		t.Fatalf("negative mem: err = %v", err)
	}
	tok, err := p.Acquire(context.Background(), 2, 2)
	if err != nil {
		t.Fatalf("pool poisoned by invalid requests: %v", err)
	}
	tok.Release()
}
