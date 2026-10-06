package proxy

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type fakeHandle struct {
	resultCh  chan Result
	closeErr  error
	closeWait time.Duration
	closed    *atomic.Int32
}

func (h *fakeHandle) Result() <-chan Result { return h.resultCh }

func (h *fakeHandle) Close() error {
	if h.closeWait > 0 {
		time.Sleep(h.closeWait)
	}
	h.closed.Add(1)
	return h.closeErr
}

type fakeHop struct {
	name     string
	handle   *fakeHandle
	openErr  error
	openHook func()
}

func (f *fakeHop) Name() string { return f.name }

func (f *fakeHop) Forward(_ context.Context, _ Request) (Handle, error) {
	if f.openErr != nil {
		return nil, f.openErr
	}
	if f.openHook != nil {
		f.openHook()
	}
	return f.handle, nil
}

func resultHandle(payload string, complete bool) *fakeHandle {
	ch := make(chan Result, 1)
	ch <- Result{Resp: Response{Payload: []byte(payload), Complete: complete}}
	return &fakeHandle{resultCh: ch, closed: &atomic.Int32{}}
}

func blockingHandle(closeWait time.Duration, closeErr error) *fakeHandle {
	return &fakeHandle{
		resultCh:  make(chan Result),
		closeWait: closeWait,
		closeErr:  closeErr,
		closed:    &atomic.Int32{},
	}
}

func TestForwardSuccessReturnsFinalHopResponse(t *testing.T) {
	hops := []Hop{
		&fakeHop{name: "h1", handle: resultHandle("one", false)},
		&fakeHop{name: "h2", handle: resultHandle("two", false)},
		&fakeHop{name: "h3", handle: resultHandle("final", true)},
	}
	p, err := New(hops...)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	resp, err := p.Forward(context.Background(), Request{ID: "r1"})
	if err != nil {
		t.Fatalf("Forward: %v", err)
	}
	if got := string(resp.Payload); got != "final" {
		t.Fatalf("payload = %q, want %q", got, "final")
	}
	for i, hop := range hops {
		h := hop.(*fakeHop).handle
		if h.closed.Load() != 1 {
			t.Fatalf("hop %d closed %d times, want 1", i, h.closed.Load())
		}
	}
}

func TestForwardMidHopFailureClosesOpenedHopsOnly(t *testing.T) {
	h1 := resultHandle("one", false)
	failErr := errors.New("hop2 boom")
	ch2 := make(chan Result, 1)
	ch2 <- Result{Err: failErr}
	h2 := &fakeHandle{resultCh: ch2, closed: &atomic.Int32{}}
	h3 := resultHandle("final", true)
	var h3Opened atomic.Int32

	p, _ := New(
		&fakeHop{name: "h1", handle: h1},
		&fakeHop{name: "h2", handle: h2},
		&fakeHop{name: "h3", handle: h3, openHook: func() { h3Opened.Add(1) }},
	)
	_, err := p.Forward(context.Background(), Request{ID: "r2"})
	if !errors.Is(err, failErr) {
		t.Fatalf("err = %v, want wrap of %v", err, failErr)
	}
	if h1.closed.Load() != 1 || h2.closed.Load() != 1 {
		t.Fatalf("opened hops closed h1=%d h2=%d, want 1 each", h1.closed.Load(), h2.closed.Load())
	}
	if h3Opened.Load() != 0 {
		t.Fatalf("hop3 must not be opened after hop2 failure, opened %d", h3Opened.Load())
	}
}

func TestForwardCancelWaitsForAllOpenedHopsAndAggregatesCloseErrors(t *testing.T) {
	closeErr1 := errors.New("close h1 failed")
	closeErr2 := errors.New("close h2 failed")
	h1 := resultHandle("one", false)
	h1.closeWait = 60 * time.Millisecond
	h1.closeErr = closeErr1
	h2 := blockingHandle(60*time.Millisecond, closeErr2)
	h2Opened := make(chan struct{})

	p, _ := New(
		&fakeHop{name: "h1", handle: h1},
		&fakeHop{name: "h2", handle: h2, openHook: func() { close(h2Opened) }},
		&fakeHop{name: "h3", handle: blockingHandle(0, nil)},
	)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := p.Forward(ctx, Request{ID: "r3"})
		done <- err
	}()

	<-h2Opened // 等第二跳开启后再取消，确保两跳都在关闭清单里
	start := time.Now()
	cancel()
	err := <-done
	elapsed := time.Since(start)

	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if !errors.Is(err, closeErr1) || !errors.Is(err, closeErr2) {
		t.Fatalf("err = %v, want aggregated close errors", err)
	}
	if h1.closed.Load() != 1 || h2.closed.Load() != 1 {
		t.Fatalf("closed counts h1=%d h2=%d, want 1 each", h1.closed.Load(), h2.closed.Load())
	}
	if elapsed < 100*time.Millisecond {
		t.Fatalf("returned after %v before waiting for hop closes", elapsed)
	}
}

func TestForwardRejectsIncompleteFinalResponse(t *testing.T) {
	p, _ := New(&fakeHop{name: "only", handle: resultHandle("partial", false)})
	_, err := p.Forward(context.Background(), Request{ID: "r4"})
	if err == nil || !strings.Contains(err.Error(), "incomplete") {
		t.Fatalf("err = %v, want incomplete final response error", err)
	}
}

func TestPromiseIgnoresLateCompletion(t *testing.T) {
	pr := NewPromise[string]()
	if pr.State() != Pending {
		t.Fatalf("initial state = %v, want Pending", pr.State())
	}
	if !pr.Resolve("first") {
		t.Fatal("first Resolve should succeed")
	}
	if pr.Resolve("late") {
		t.Fatal("late Resolve must be ignored")
	}
	if pr.Reject(errors.New("late failure")) {
		t.Fatal("late Reject must be ignored")
	}
	if pr.State() != Fulfilled {
		t.Fatalf("state = %v, want Fulfilled", pr.State())
	}
	v, err := pr.Wait()
	if err != nil || v != "first" {
		t.Fatalf("Wait = (%q, %v), want (first, nil)", v, err)
	}
}

func TestPromiseRejectThenLateResolve(t *testing.T) {
	pr := NewPromise[int]()
	want := errors.New("nope")
	if !pr.Reject(want) {
		t.Fatal("first Reject should succeed")
	}
	if pr.Resolve(42) {
		t.Fatal("late Resolve must be ignored")
	}
	if pr.State() != Rejected {
		t.Fatalf("state = %v, want Rejected", pr.State())
	}
	if _, err := pr.Wait(); !errors.Is(err, want) {
		t.Fatalf("err = %v, want %v", err, want)
	}
}

func TestNewRequiresAtLeastOneHop(t *testing.T) {
	if _, err := New(); err == nil {
		t.Fatal("New() with no hops should fail")
	}
}
