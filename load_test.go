package cache

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// gateLoader is a loader whose completion is controlled by the test: it
// blocks until proceed is closed, like a manually-resolved promise.
type gateLoader struct {
	calls   atomic.Int32
	started chan struct{}
	proceed chan struct{}
	ctxs    chan context.Context
	val     int
	size    int64
	err     error
}

func newGateLoader(val int, size int64) *gateLoader {
	return &gateLoader{
		started: make(chan struct{}, 16),
		proceed: make(chan struct{}),
		ctxs:    make(chan context.Context, 16),
		val:     val,
		size:    size,
	}
}

func (g *gateLoader) load(ctx context.Context) (int, int64, error) {
	g.calls.Add(1)
	g.started <- struct{}{}
	g.ctxs <- ctx
	<-g.proceed
	if err := ctx.Err(); err != nil {
		return 0, 0, err
	}
	return g.val, g.size, g.err
}

type loadResult struct {
	val int
	err error
}

func asyncLoad(c *Cache[string, int], ctx context.Context, key string, reserve int64, g *gateLoader) chan loadResult {
	ch := make(chan loadResult, 1)
	go func() {
		v, err := c.Load(ctx, key, reserve, g.load)
		ch <- loadResult{v, err}
	}()
	return ch
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timeout waiting for %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

func (c *Cache[K, V]) loadWaiters(key K) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	if lc, ok := c.loads[key]; ok {
		return lc.waiters
	}
	return -1
}

func TestLoadSingleflight(t *testing.T) {
	c := New[string, int](100)
	g := newGateLoader(7, 10)
	r1 := asyncLoad(c, context.Background(), "a", 10, g)
	r2 := asyncLoad(c, context.Background(), "a", 10, g)

	<-g.started
	waitFor(t, "both waiters attached", func() bool { return c.loadWaiters("a") == 2 })
	if n := g.calls.Load(); n != 1 {
		t.Fatalf("loader called %d times, want 1", n)
	}
	close(g.proceed)

	for i, r := range []chan loadResult{r1, r2} {
		res := <-r
		if res.err != nil || res.val != 7 {
			t.Fatalf("waiter %d: got (%v, %v), want (7, nil)", i, res.val, res.err)
		}
	}
	if n := g.calls.Load(); n != 1 {
		t.Fatalf("loader called %d times, want 1", n)
	}
	if v, ok := c.Get("a"); !ok || v != 7 {
		t.Fatal("loaded page must be cached")
	}
	if c.Used() != 10 || c.Reserved() != 0 {
		t.Fatalf("used=%d reserved=%d, want 10/0", c.Used(), c.Reserved())
	}
}

func TestLoadCacheHitSkipsLoader(t *testing.T) {
	c := New[string, int](100)
	mustInsert(t, c, "a", 5, 10)
	g := newGateLoader(7, 10)
	v, err := c.Load(context.Background(), "a", 10, g.load)
	if err != nil || v != 5 {
		t.Fatalf("got (%v, %v), want (5, nil)", v, err)
	}
	if g.calls.Load() != 0 {
		t.Fatal("loader must not run on a cache hit")
	}
}

func TestLoadStaleVersionNotPublished(t *testing.T) {
	c := New[string, int](100)
	g := newGateLoader(9, 10)
	r := asyncLoad(c, context.Background(), "a", 10, g)
	<-g.started

	// Version bump while the load is in flight.
	c.Invalidate("a")
	close(g.proceed)

	res := <-r
	if res.err != nil || res.val != 9 {
		t.Fatalf("waiter got (%v, %v), want (9, nil)", res.val, res.err)
	}
	if _, ok := c.Get("a"); ok {
		t.Fatal("stale load result must not be published")
	}
	if c.Used() != 0 || c.Reserved() != 0 {
		t.Fatalf("used=%d reserved=%d, want 0/0", c.Used(), c.Reserved())
	}
}

func TestLoadInsertDuringLoadNotPublished(t *testing.T) {
	c := New[string, int](100)
	g := newGateLoader(9, 10)
	r := asyncLoad(c, context.Background(), "a", 10, g)
	<-g.started

	// An explicit insert supersedes the in-flight load.
	mustInsert(t, c, "a", 1, 10)
	close(g.proceed)

	res := <-r
	if res.err != nil || res.val != 9 {
		t.Fatalf("waiter got (%v, %v), want (9, nil)", res.val, res.err)
	}
	if v, _ := c.Get("a"); v != 1 {
		t.Fatalf("cached value=%d, want 1 (inserted value must win)", v)
	}
}

func TestLoadCancelOnlyWhenAllWaitersCancel(t *testing.T) {
	c := New[string, int](100)
	g := newGateLoader(1, 10)
	ctx1, cancel1 := context.WithCancel(context.Background())
	ctx2, cancel2 := context.WithCancel(context.Background())
	r1 := asyncLoad(c, ctx1, "a", 10, g)
	r2 := asyncLoad(c, ctx2, "a", 10, g)

	<-g.started
	waitFor(t, "both waiters attached", func() bool { return c.loadWaiters("a") == 2 })
	lctx := <-g.ctxs

	cancel1()
	if res := <-r1; !errors.Is(res.err, context.Canceled) {
		t.Fatalf("waiter 1 err=%v, want context.Canceled", res.err)
	}
	select {
	case <-lctx.Done():
		t.Fatal("load cancelled while a waiter remains")
	case <-time.After(50 * time.Millisecond):
	}

	cancel2()
	if res := <-r2; !errors.Is(res.err, context.Canceled) {
		t.Fatalf("waiter 2 err=%v, want context.Canceled", res.err)
	}
	select {
	case <-lctx.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("load not cancelled after all waiters cancelled")
	}

	close(g.proceed) // loader observes cancellation and returns
	waitFor(t, "load cleaned up", func() bool {
		return c.loadWaiters("a") == -1 && c.Reserved() == 0
	})
	if c.Len() != 0 {
		t.Fatal("cancelled load must not publish")
	}
}

func TestLoadReservationSharesBudget(t *testing.T) {
	c := New[string, int](100)
	mustInsert(t, c, "x", 1, 60)

	// 60 used + 50 reserved > 100: rejected before the loader runs.
	g0 := newGateLoader(0, 50)
	if _, err := c.Load(context.Background(), "a", 50, g0.load); !errors.Is(err, ErrBudgetExhausted) {
		t.Fatalf("err=%v, want ErrBudgetExhausted", err)
	}
	if g0.calls.Load() != 0 {
		t.Fatal("loader must not start when the reservation does not fit")
	}

	// 60 used + 40 reserved == 100: fits.
	g := newGateLoader(2, 40)
	r := asyncLoad(c, context.Background(), "a", 40, g)
	<-g.started
	if c.Reserved() != 40 {
		t.Fatalf("reserved=%d, want 40", c.Reserved())
	}

	// The reservation blocks an insert that would otherwise fit (without
	// the 40 reserved bytes, evicting x would make room for 70), and the
	// failed insert must not evict x to make room.
	if err := c.Insert("y", 3, 70); !errors.Is(err, ErrBudgetExhausted) {
		t.Fatalf("err=%v, want ErrBudgetExhausted", err)
	}
	if _, ok := c.Get("x"); !ok {
		t.Fatal("failed insert must not evict x")
	}

	close(g.proceed)
	res := <-r
	if res.err != nil || res.val != 2 {
		t.Fatalf("got (%v, %v), want (2, nil)", res.val, res.err)
	}
	if _, ok := c.Get("a"); !ok {
		t.Fatal("loaded page must be published")
	}
	if c.Used() != 100 || c.Reserved() != 0 {
		t.Fatalf("used=%d reserved=%d, want 100/0", c.Used(), c.Reserved())
	}
}

func TestLoadPublishEvictsUnpinned(t *testing.T) {
	c := New[string, int](100)
	mustInsert(t, c, "x", 1, 70)
	// Reserve 10 but the actual object is 40: publishing evicts x.
	g := newGateLoader(5, 40)
	r := asyncLoad(c, context.Background(), "a", 10, g)
	<-g.started
	close(g.proceed)

	res := <-r
	if res.err != nil || res.val != 5 {
		t.Fatalf("got (%v, %v), want (5, nil)", res.val, res.err)
	}
	if _, ok := c.Get("x"); ok {
		t.Fatal("x should have been evicted to publish the load")
	}
	if _, ok := c.Get("a"); !ok {
		t.Fatal("loaded page must be published")
	}
	if c.Used() != 40 {
		t.Fatalf("used=%d, want 40", c.Used())
	}
}

func TestLoadPublishSkippedWhenBudgetPinned(t *testing.T) {
	c := New[string, int](100)
	mustInsert(t, c, "x", 1, 70)
	_, lease, _ := c.Lease("x")
	defer lease.Release()

	// Actual size 40 cannot fit: 70 pinned + 40 > 100.
	g := newGateLoader(5, 40)
	r := asyncLoad(c, context.Background(), "a", 10, g)
	<-g.started
	close(g.proceed)

	res := <-r
	if res.err != nil || res.val != 5 {
		t.Fatalf("waiter must still get the value, got (%v, %v)", res.val, res.err)
	}
	if _, ok := c.Get("a"); ok {
		t.Fatal("unpublishable result must not be cached")
	}
	if _, ok := c.Get("x"); !ok {
		t.Fatal("pinned x must survive")
	}
	if c.Used() != 70 || c.Reserved() != 0 {
		t.Fatalf("used=%d reserved=%d, want 70/0", c.Used(), c.Reserved())
	}
}

func TestLoadErrorPropagates(t *testing.T) {
	c := New[string, int](100)
	g := newGateLoader(0, 10)
	g.err = errors.New("boom")
	r1 := asyncLoad(c, context.Background(), "a", 10, g)
	r2 := asyncLoad(c, context.Background(), "a", 10, g)
	<-g.started
	waitFor(t, "both waiters attached", func() bool { return c.loadWaiters("a") == 2 })
	close(g.proceed)

	for i, r := range []chan loadResult{r1, r2} {
		if res := <-r; res.err == nil || res.err.Error() != "boom" {
			t.Fatalf("waiter %d: err=%v, want boom", i, res.err)
		}
	}
	if c.Len() != 0 || c.Used() != 0 || c.Reserved() != 0 {
		t.Fatal("failed load must leave no trace")
	}
}

func TestLoadConcurrentStress(t *testing.T) {
	c := New[string, int](1000)
	var wg sync.WaitGroup
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			key := string(rune('a' + i%8))
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			for j := 0; j < 50; j++ {
				v, err := c.Load(ctx, key, 10, func(ctx context.Context) (int, int64, error) {
					return len(key), 10, nil
				})
				if err == nil && v != 1 {
					t.Errorf("got value %d, want 1", v)
					return
				}
				if j%7 == 0 {
					c.Invalidate(key)
				}
			}
		}(i)
	}
	wg.Wait()
	if c.Reserved() != 0 {
		t.Fatalf("reserved=%d after all loads, want 0", c.Reserved())
	}
	if c.Used() > 1000 {
		t.Fatalf("used=%d exceeds budget", c.Used())
	}
}
