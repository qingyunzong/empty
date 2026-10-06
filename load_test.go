package cache

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// promise is a manually controlled loader result: the test decides exactly
// when (and with what) a load completes, and observes loader cancellation.
type promise struct {
	started  chan struct{}
	resolve  chan any
	done     chan struct{} // closed when the loader function returns
	ctxErr   chan error    // loader ctx cancellation, if any
	execCnt  *atomic.Int32
	resolved *atomic.Bool
}

func newPromise(execCnt *atomic.Int32) *promise {
	return &promise{
		started:  make(chan struct{}),
		resolve:  make(chan any),
		done:     make(chan struct{}),
		ctxErr:   make(chan error, 1),
		execCnt:  execCnt,
		resolved: &atomic.Bool{},
	}
}

func (p *promise) fn() func(context.Context) (any, error) {
	var once sync.Once
	return func(ctx context.Context) (any, error) {
		p.execCnt.Add(1)
		once.Do(func() { close(p.started) })
		defer close(p.done)
		select {
		case v := <-p.resolve:
			p.resolved.Store(true)
			return v, nil
		case <-ctx.Done():
			p.ctxErr <- ctx.Err()
			return nil, ctx.Err()
		}
	}
}

func mustNotStart(t *testing.T, p *promise, what string) {
	t.Helper()
	select {
	case <-p.started:
		t.Fatalf("%s: loader started unexpectedly", what)
	case <-time.After(50 * time.Millisecond):
	}
}

// TestLoadSingleFlight: concurrent loads of the same page execute the loader
// exactly once and all waiters receive the published value.
func TestLoadSingleFlight(t *testing.T) {
	c := New(1000)
	var execCnt atomic.Int32
	p := newPromise(&execCnt)

	const waitersN = 8
	results := make(chan any, waitersN)
	for i := 0; i < waitersN; i++ {
		go func() {
			v, err := c.Load(context.Background(), "page", 100, p.fn())
			if err != nil {
				t.Errorf("load: %v", err)
			}
			results <- v
		}()
	}
	<-p.started
	// Give every waiter a chance to join, then confirm still one execution.
	time.Sleep(50 * time.Millisecond)
	if got := execCnt.Load(); got != 1 {
		t.Fatalf("loader executed %d times before resolve, want 1", got)
	}
	p.resolve <- "shared"
	for i := 0; i < waitersN; i++ {
		v := <-results
		if v != "shared" {
			t.Fatalf("waiter got %v, want shared", v)
		}
	}
	if got := execCnt.Load(); got != 1 {
		t.Fatalf("loader executed %d times, want 1", got)
	}
	if v, ok := c.Get("page"); !ok || v != "shared" {
		t.Fatalf("page not published: %v %v", v, ok)
	}
	if c.Used() != 100 {
		t.Fatalf("used = %d, want 100 (reservation converted to page)", c.Used())
	}
}

// TestLoadStaleVersionNotPublished: Invalidate during a load bumps the page
// version; the stale result reaches waiters but is never cached.
func TestLoadStaleVersionNotPublished(t *testing.T) {
	c := New(1000)
	var execCnt atomic.Int32
	p := newPromise(&execCnt)

	result := make(chan any, 1)
	go func() {
		v, err := c.Load(context.Background(), "k", 50, p.fn())
		if err != nil {
			t.Errorf("load: %v", err)
		}
		result <- v
	}()
	<-p.started
	if reserved, _, ok := c.inflight("k"); !ok || reserved != 50 {
		t.Fatalf("inflight = %d,%v; want 50,true", reserved, ok)
	}
	c.Invalidate("k") // version bump while load is in flight
	p.resolve <- "stale-value"

	if v := <-result; v != "stale-value" {
		t.Fatalf("waiter got %v, want stale-value delivered", v)
	}
	if c.Has("k") {
		t.Fatal("stale load result must not be published")
	}
	if c.Used() != 0 {
		t.Fatalf("used = %d, want 0 (reservation released)", c.Used())
	}

	// A fresh load must re-execute the loader and now publish.
	p2 := newPromise(&execCnt)
	result2 := make(chan any, 1)
	go func() {
		v, _ := c.Load(context.Background(), "k", 50, p2.fn())
		result2 <- v
	}()
	<-p2.started
	p2.resolve <- "fresh"
	if v := <-result2; v != "fresh" {
		t.Fatalf("got %v, want fresh", v)
	}
	if v, ok := c.Get("k"); !ok || v != "fresh" {
		t.Fatalf("fresh value not published: %v %v", v, ok)
	}
	if got := execCnt.Load(); got != 2 {
		t.Fatalf("loader executed %d times, want 2", got)
	}
}

// TestLoadStopsOnlyWhenAllWaitersCancel: cancelling one waiter leaves the
// load running; only the last cancellation stops it and frees the reservation.
func TestLoadStopsOnlyWhenAllWaitersCancel(t *testing.T) {
	c := New(100)
	var execCnt atomic.Int32
	p := newPromise(&execCnt)

	ctx1, cancel1 := context.WithCancel(context.Background())
	ctx2, cancel2 := context.WithCancel(context.Background())
	errs := make(chan error, 2)
	go func() {
		_, err := c.Load(ctx1, "k", 60, p.fn())
		errs <- err
	}()
	<-p.started
	go func() {
		_, err := c.Load(ctx2, "k", 60, p.fn())
		errs <- err
	}()
	// Wait until the second waiter has joined.
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, w, _ := c.inflight("k"); w == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("second waiter never joined")
		}
		time.Sleep(time.Millisecond)
	}

	cancel1()
	if err := <-errs; err != context.Canceled {
		t.Fatalf("waiter1 err = %v, want context.Canceled", err)
	}
	// Load must still be running: reservation held, loader not cancelled.
	if reserved, w, ok := c.inflight("k"); !ok || reserved != 60 || w != 1 {
		t.Fatalf("after one cancel: inflight=%d waiters=%d ok=%v", reserved, w, ok)
	}
	if c.Used() != 60 {
		t.Fatalf("used = %d, want 60 (reservation still held)", c.Used())
	}
	select {
	case err := <-p.ctxErr:
		t.Fatalf("loader cancelled while a waiter remained: %v", err)
	case <-time.After(50 * time.Millisecond):
	}

	cancel2()
	if err := <-errs; err != context.Canceled {
		t.Fatalf("waiter2 err = %v, want context.Canceled", err)
	}
	// Last waiter gone: loader ctx cancelled, reservation released.
	if err := <-p.ctxErr; err != context.Canceled {
		t.Fatalf("loader ctx err = %v, want context.Canceled", err)
	}
	<-p.done
	deadline = time.Now().Add(2 * time.Second)
	for c.Used() != 0 {
		if time.Now().After(deadline) {
			t.Fatalf("used = %d, want 0 after all waiters cancelled", c.Used())
		}
		time.Sleep(time.Millisecond)
	}
	if _, _, ok := c.inflight("k"); ok {
		t.Fatal("load entry must be removed after all waiters cancel")
	}
}

// TestLoadReservationSharesBudget: an in-flight reservation blocks inserts
// just like cached bytes, and a new load may evict unleased pages to reserve.
func TestLoadReservationSharesBudget(t *testing.T) {
	c := New(100)
	var execCnt atomic.Int32

	// 80 cached bytes; a 60-byte load must evict the unleased page to reserve.
	if err := c.Put("cached", "C", 80); err != nil {
		t.Fatal(err)
	}
	p := newPromise(&execCnt)
	result := make(chan any, 1)
	go func() {
		v, err := c.Load(context.Background(), "big", 60, p.fn())
		if err != nil {
			t.Errorf("load: %v", err)
		}
		result <- v
	}()
	<-p.started
	if c.Has("cached") {
		t.Fatal("load reservation should have evicted the unleased 80-byte page")
	}
	if c.Used() != 60 {
		t.Fatalf("used = %d, want 60 (reservation only)", c.Used())
	}

	// While 60 bytes are reserved, a 50-byte insert cannot fit and must fail
	// without disturbing the reservation.
	if err := c.Put("other", "O", 50); err != ErrBudgetExceeded {
		t.Fatalf("put during reservation: %v, want ErrBudgetExceeded", err)
	}
	if c.Used() != 60 {
		t.Fatalf("used = %d after failed put, want 60", c.Used())
	}

	p.resolve <- "B"
	if v := <-result; v != "B" {
		t.Fatalf("got %v, want B", v)
	}
	if c.Used() != 60 || !c.Has("big") {
		t.Fatalf("after publish: used=%d has(big)=%v", c.Used(), c.Has("big"))
	}
}

// TestLoadOversizedReservationFails without touching cached pages.
func TestLoadOversizedReservationFails(t *testing.T) {
	c := New(100)
	if err := c.Put("keep", "K", 90); err != nil {
		t.Fatal(err)
	}
	l, _ := c.Lease("keep")
	defer l.Release()

	var execCnt atomic.Int32
	p := newPromise(&execCnt)
	_, err := c.Load(context.Background(), "huge", 200, p.fn())
	if err != ErrBudgetExceeded {
		t.Fatalf("err = %v, want ErrBudgetExceeded", err)
	}
	if execCnt.Load() != 0 {
		t.Fatal("loader must not run when the reservation does not fit")
	}
	if !c.Has("keep") || c.Used() != 90 {
		t.Fatalf("cache disturbed: used=%d has(keep)=%v", c.Used(), c.Has("keep"))
	}
}

// TestLoadCacheHitSkipsLoader: a hit only advances the access sequence and
// never runs the loader.
func TestLoadCacheHitSkipsLoader(t *testing.T) {
	c := New(100)
	if err := c.Put("p", "V", 10); err != nil {
		t.Fatal(err)
	}
	var execCnt atomic.Int32
	p := newPromise(&execCnt)
	v, err := c.Load(context.Background(), "p", 10, p.fn())
	if err != nil || v != "V" {
		t.Fatalf("got (%v,%v), want (V,nil)", v, err)
	}
	mustNotStart(t, p, "cache hit")
	if execCnt.Load() != 0 {
		t.Fatal("loader ran on a cache hit")
	}
}
