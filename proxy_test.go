package proxy

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeHop builds a Hop from a function.
type fakeHop struct {
	open func(ctx context.Context, req *Request) (HopHandle, error)
}

func (f fakeHop) Open(ctx context.Context, req *Request) (HopHandle, error) {
	return f.open(ctx, req)
}

// fakeHandle is a configurable HopHandle.
type fakeHandle struct {
	results chan Result
	closeFn func() error
}

func (h *fakeHandle) Results() <-chan Result { return h.results }
func (h *fakeHandle) Close() error           { return h.closeFn() }

// immediateHop returns a hop that instantly delivers res on open and closes
// its result stream on Close.
func immediateHop(res Result, closed *atomic.Int32) fakeHop {
	return fakeHop{open: func(ctx context.Context, req *Request) (HopHandle, error) {
		ch := make(chan Result, 1)
		ch <- res
		return &fakeHandle{
			results: ch,
			closeFn: func() error {
				if closed != nil {
					closed.Add(1)
				}
				close(ch)
				return nil
			},
		}, nil
	}}
}

func TestForwardSuccessTakesFinalHopResponse(t *testing.T) {
	hops := []Hop{
		immediateHop(Result{Resp: &Response{Status: 100, Body: []byte("hop0")}}, nil),
		immediateHop(Result{Resp: &Response{Status: 100, Body: []byte("hop1")}}, nil),
		immediateHop(Result{Resp: &Response{Status: 200, Body: []byte("final")}}, nil),
	}
	p, err := New(hops)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := p.Forward(context.Background(), &Request{Body: []byte("ping")})
	if err != nil {
		t.Fatalf("Forward: %v", err)
	}
	if got := string(resp.Body); got != "final" {
		t.Fatalf("want final hop response, got %q", got)
	}
	if resp.Status != 200 {
		t.Fatalf("want status 200, got %d", resp.Status)
	}
}

func TestNewRequiresAtLeastOneHop(t *testing.T) {
	if _, err := New(nil); err == nil {
		t.Fatal("expected error for empty hop chain")
	}
}

func TestCallerCancelWaitsForAllHopsToClose(t *testing.T) {
	release := make(chan struct{})
	var started, finished atomic.Int32

	blockedClose := func() error {
		started.Add(1)
		<-release // simulate slow per-hop teardown
		finished.Add(1)
		return nil
	}
	blockedHop := func(ctx context.Context, req *Request) (HopHandle, error) {
		ch := make(chan Result)
		return &fakeHandle{results: ch, closeFn: blockedClose}, nil
	}

	p, err := New([]Hop{fakeHop{open: blockedHop}, fakeHop{open: blockedHop}, fakeHop{open: blockedHop}})
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := p.Forward(ctx, &Request{})
		done <- err
	}()

	// Let the first hop open, then cancel the caller.
	time.Sleep(50 * time.Millisecond)
	cancel()

	// Forward must still be blocked waiting for the close to finish.
	time.Sleep(50 * time.Millisecond)
	select {
	case <-done:
		t.Fatal("Forward returned before opened hops finished closing")
	default:
	}
	if started.Load() != 1 {
		t.Fatalf("want 1 close started, got %d", started.Load())
	}

	close(release)
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("want context.Canceled, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Forward did not return after closes finished")
	}
	if finished.Load() != started.Load() {
		t.Fatalf("closes started=%d finished=%d", started.Load(), finished.Load())
	}
}

func TestCancelClosesEveryOpenedHop(t *testing.T) {
	var closed atomic.Int32
	hop := func(ctx context.Context, req *Request) (HopHandle, error) {
		ch := make(chan Result)
		return &fakeHandle{
			results: ch,
			closeFn: func() error {
				closed.Add(1)
				close(ch)
				return nil
			},
		}, nil
	}
	// First hop never delivers; cancel must still close it.
	p, _ := New([]Hop{fakeHop{open: hop}})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := p.Forward(ctx, &Request{}); done <- err }()

	time.Sleep(50 * time.Millisecond)
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("want context.Canceled, got %v", err)
	}
	if closed.Load() != 1 {
		t.Fatalf("want 1 closed hop, got %d", closed.Load())
	}
}

func TestCloseFailuresAreAggregated(t *testing.T) {
	errClose1 := errors.New("close failure one")
	errClose2 := errors.New("close failure two")
	closeErrs := []error{errClose1, errClose2}
	var i atomic.Int32

	hop := func(ctx context.Context, req *Request) (HopHandle, error) {
		ch := make(chan Result, 1)
		ch <- Result{Resp: &Response{Status: 100}}
		idx := int(i.Add(1)) - 1
		return &fakeHandle{
			results: ch,
			closeFn: func() error { return closeErrs[idx] },
		}, nil
	}
	// Fail the second hop mid-way so both opened hops get closed.
	failHop := func(ctx context.Context, req *Request) (HopHandle, error) {
		ch := make(chan Result, 1)
		ch <- Result{Err: errors.New("boom")}
		return &fakeHandle{results: ch, closeFn: func() error { return nil }}, nil
	}

	p, _ := New([]Hop{fakeHop{open: hop}, fakeHop{open: hop}, fakeHop{open: failHop}})
	_, err := p.Forward(context.Background(), &Request{})
	if err == nil {
		t.Fatal("expected error")
	}
	for _, want := range []error{errClose1, errClose2} {
		if !errors.Is(err, want) {
			t.Fatalf("aggregated error missing %v: %v", want, err)
		}
	}
}

func TestMidHopFailureClosesOpenedHops(t *testing.T) {
	var closed atomic.Int32
	okHop := immediateHop(Result{Resp: &Response{Status: 100}}, &closed)
	boom := errors.New("hop exploded")
	badHop := fakeHop{open: func(ctx context.Context, req *Request) (HopHandle, error) {
		ch := make(chan Result, 1)
		ch <- Result{Err: boom}
		return &fakeHandle{results: ch, closeFn: func() error { return nil }}, nil
	}}
	neverOpened := fakeHop{open: func(ctx context.Context, req *Request) (HopHandle, error) {
		t.Error("third hop must never open")
		return nil, nil
	}}

	p, _ := New([]Hop{okHop, badHop, neverOpened})
	_, err := p.Forward(context.Background(), &Request{})
	if !errors.Is(err, boom) {
		t.Fatalf("want %v, got %v", boom, err)
	}
	if closed.Load() != 1 {
		t.Fatalf("want first hop closed once, got %d", closed.Load())
	}
}

func TestOpenFailureClosesPreviouslyOpenedHops(t *testing.T) {
	var closed atomic.Int32
	okHop := immediateHop(Result{Resp: &Response{Status: 100}}, &closed)
	openErr := errors.New("dial refused")
	badOpen := fakeHop{open: func(ctx context.Context, req *Request) (HopHandle, error) {
		return nil, openErr
	}}

	p, _ := New([]Hop{okHop, badOpen})
	_, err := p.Forward(context.Background(), &Request{})
	if !errors.Is(err, openErr) {
		t.Fatalf("want %v, got %v", openErr, err)
	}
	if closed.Load() != 1 {
		t.Fatalf("want first hop closed once, got %d", closed.Load())
	}
}

func TestLateCompletionIsEnumeratedAndIgnored(t *testing.T) {
	lateResult := make(chan Result, 1)
	closed := make(chan struct{})

	// Hop 0: never delivers until after Close, then completes late.
	slowHop := fakeHop{open: func(ctx context.Context, req *Request) (HopHandle, error) {
		return &fakeHandle{
			results: lateResult,
			closeFn: func() error {
				close(closed)
				// Deliver a late result after the hop was closed.
				lateResult <- Result{Resp: &Response{Status: 200, Body: []byte("too late")}}
				return nil
			},
		}, nil
	}}

	type settle struct {
		hop int
		st  State
	}
	settled := make(chan settle, 4)
	p, _ := New([]Hop{slowHop}, WithSettleObserver(func(hop int, s State) {
		settled <- settle{hop, s}
	}))

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := p.Forward(ctx, &Request{}); done <- err }()

	time.Sleep(50 * time.Millisecond)
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("want context.Canceled, got %v", err)
	}
	<-closed

	// The late arrival must be reported as LateCompleted, not Fulfilled.
	select {
	case s := <-settled:
		if s.st != LateCompleted {
			t.Fatalf("want LateCompleted, got %v", s.st)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("late settlement was not observed")
	}
}

func TestPromiseSettleOnce(t *testing.T) {
	pr := NewPromise()
	if pr.State() != Pending {
		t.Fatalf("want Pending, got %v", pr.State())
	}
	if st := pr.Settle(Result{Resp: &Response{Status: 200}}); st != Fulfilled {
		t.Fatalf("want Fulfilled, got %v", st)
	}
	if st := pr.Settle(Result{Err: errors.New("late")}); st != LateCompleted {
		t.Fatalf("want LateCompleted, got %v", st)
	}
	if st := pr.Settle(Result{}); st != LateCompleted {
		t.Fatalf("want LateCompleted, got %v", st)
	}
	if pr.LateCount() != 2 {
		t.Fatalf("want 2 late arrivals, got %d", pr.LateCount())
	}
	if pr.State() != Fulfilled {
		t.Fatalf("first settlement must win, got %v", pr.State())
	}
	if pr.Result().Resp.Status != 200 {
		t.Fatalf("late results must not overwrite, got %+v", pr.Result())
	}
}

func TestPromiseFailureEnum(t *testing.T) {
	pr := NewPromise()
	if st := pr.Settle(Result{Err: errors.New("nope")}); st != Failed {
		t.Fatalf("want Failed, got %v", st)
	}
	select {
	case <-pr.Done():
	default:
		t.Fatal("Done must be closed after settlement")
	}
}

func TestConcurrentForward(t *testing.T) {
	p, _ := New([]Hop{
		immediateHop(Result{Resp: &Response{Status: 100}}, nil),
		immediateHop(Result{Resp: &Response{Status: 200, Body: []byte("ok")}}, nil),
	})
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			resp, err := p.Forward(context.Background(), &Request{Body: []byte(fmt.Sprint(i))})
			if err != nil {
				t.Errorf("Forward %d: %v", i, err)
				return
			}
			if string(resp.Body) != "ok" {
				t.Errorf("Forward %d: got %q", i, resp.Body)
			}
		}(i)
	}
	wg.Wait()
}
