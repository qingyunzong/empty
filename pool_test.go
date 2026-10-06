package pool

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// tracker records every produced and destroyed object so tests can verify
// that each object is destroyed exactly once and nothing leaks.
type tracker struct {
	mu        sync.Mutex
	nextID    int
	produced  map[int]struct{}
	destroyed map[int]int
	live      atomic.Int32
	maxLive   atomic.Int32
}

type obj struct{ id int }

func newTracker() *tracker {
	return &tracker{
		produced:  make(map[int]struct{}),
		destroyed: make(map[int]int),
	}
}

func (tr *tracker) factory(context.Context) (*obj, error) {
	tr.mu.Lock()
	tr.nextID++
	id := tr.nextID
	tr.produced[id] = struct{}{}
	tr.mu.Unlock()

	cur := tr.live.Add(1)
	for {
		old := tr.maxLive.Load()
		if cur <= old || tr.maxLive.CompareAndSwap(old, cur) {
			break
		}
	}
	return &obj{id: id}, nil
}

func (tr *tracker) destroy(o *obj) {
	tr.live.Add(-1)
	tr.mu.Lock()
	tr.destroyed[o.id]++
	tr.mu.Unlock()
}

// verify checks: every produced object destroyed exactly once, nothing else
// destroyed, and no live objects remain.
func (tr *tracker) verify(t *testing.T) {
	t.Helper()
	tr.mu.Lock()
	defer tr.mu.Unlock()
	for id := range tr.produced {
		if tr.destroyed[id] != 1 {
			t.Fatalf("object %d destroyed %d times, want exactly 1", id, tr.destroyed[id])
		}
	}
	for id := range tr.destroyed {
		if _, ok := tr.produced[id]; !ok {
			t.Fatalf("object %d destroyed but never produced", id)
		}
	}
	if got := tr.live.Load(); got != 0 {
		t.Fatalf("live objects after drain = %d, want 0", got)
	}
}

func TestMaxLiveObjectsBarrier(t *testing.T) {
	tr := newTracker()
	const max = 5
	p, err := New[*obj](Config[*obj]{
		Factory: tr.factory,
		Reset:   func(*obj) error { return nil },
		Destroy: tr.destroy,
		Max:     max,
	})
	if err != nil {
		t.Fatal(err)
	}

	const workers = 32
	const rounds = 50
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start // barrier: release all workers at once
			for j := 0; j < rounds; j++ {
				o, err := p.Get(context.Background())
				if err != nil {
					t.Errorf("Get: %v", err)
					return
				}
				time.Sleep(time.Millisecond)
				p.Put(o)
			}
		}()
	}
	close(start)
	wg.Wait()
	p.Close()

	if got := tr.maxLive.Load(); got > max {
		t.Fatalf("max concurrent live objects = %d, exceeds Max %d", got, max)
	}
	if got := p.Live(); got != 0 {
		t.Fatalf("pool.Live() = %d after close, want 0", got)
	}
	tr.verify(t)
}

func TestDestroyExactlyOncePerObject(t *testing.T) {
	tr := newTracker()
	p, err := New[*obj](Config[*obj]{
		Factory: tr.factory,
		Reset:   func(*obj) error { return nil },
		Destroy: tr.destroy,
		Max:     3,
	})
	if err != nil {
		t.Fatal(err)
	}

	// Cycle more objects than Max through the pool.
	var objs []*obj
	for i := 0; i < 10; i++ {
		o, err := p.Get(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		objs = append(objs, o)
		if len(objs) > 2 {
			p.Put(objs[0])
			objs = objs[1:]
		}
	}
	for _, o := range objs {
		p.Put(o)
	}
	p.Close()
	tr.verify(t)
}

func TestResetFailureDestroysAndReleasesSlot(t *testing.T) {
	tr := newTracker()
	var failReset atomic.Bool
	p, err := New[*obj](Config[*obj]{
		Factory: tr.factory,
		Reset: func(*obj) error {
			if failReset.Load() {
				return errors.New("reset failed")
			}
			return nil
		},
		Destroy: tr.destroy,
		Max:     2,
	})
	if err != nil {
		t.Fatal(err)
	}

	o1, err := p.Get(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	o2, err := p.Get(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got := p.Live(); got != 2 {
		t.Fatalf("Live = %d, want 2", got)
	}

	// Return with a failing reset: object must be destroyed and the slot freed.
	failReset.Store(true)
	p.Put(o1)
	if got := p.Live(); got != 1 {
		t.Fatalf("Live after failed reset = %d, want 1 (slot released)", got)
	}

	// The freed slot must be reusable.
	failReset.Store(false)
	o3, err := p.Get(context.Background())
	if err != nil {
		t.Fatalf("Get after slot release: %v", err)
	}
	p.Put(o3)
	p.Put(o2)
	p.Close()
	tr.verify(t)
}

func TestFactoryFailureReleasesSlot(t *testing.T) {
	tr := newTracker()
	var fail atomic.Bool
	p, err := New[*obj](Config[*obj]{
		Factory: func(ctx context.Context) (*obj, error) {
			if fail.Load() {
				return nil, errors.New("factory boom")
			}
			return tr.factory(ctx)
		},
		Destroy: tr.destroy,
		Max:     2,
	})
	if err != nil {
		t.Fatal(err)
	}

	fail.Store(true)
	for i := 0; i < 5; i++ {
		if _, err := p.Get(context.Background()); err == nil {
			t.Fatal("expected factory error")
		}
	}
	if got := p.Live(); got != 0 {
		t.Fatalf("Live after factory failures = %d, want 0 (no leaked slots)", got)
	}

	// Pool must still reach full capacity afterwards.
	fail.Store(false)
	a, err := p.Get(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	b, err := p.Get(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got := p.Live(); got != 2 {
		t.Fatalf("Live = %d, want 2", got)
	}
	p.Put(a)
	p.Put(b)
	p.Close()
	tr.verify(t)
}

func TestWaiterCancel(t *testing.T) {
	tr := newTracker()
	p, err := New[*obj](Config[*obj]{
		Factory: tr.factory,
		Destroy: tr.destroy,
		Max:     1,
	})
	if err != nil {
		t.Fatal(err)
	}

	held, err := p.Get(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := p.Get(ctx)
		done <- err
	}()
	// Let the waiter block, then cancel.
	time.Sleep(20 * time.Millisecond)
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled Get returned %v, want context.Canceled", err)
	}
	if got := p.Live(); got != 1 {
		t.Fatalf("Live after cancel = %d, want 1 (no slot leaked)", got)
	}

	// A cancelled waiter must not steal the next returned object.
	ctx2, cancel2 := context.WithCancel(context.Background())
	cancel2()
	if _, err := p.Get(ctx2); !errors.Is(err, context.Canceled) {
		t.Fatalf("pre-cancelled Get returned %v, want context.Canceled", err)
	}
	p.Put(held)
	got, err := p.Get(context.Background())
	if err != nil {
		t.Fatalf("Get after cancelled waiters: %v", err)
	}
	p.Put(got)
	p.Close()
	tr.verify(t)
}

func TestCloseDestroysCheckedOutOnReturn(t *testing.T) {
	tr := newTracker()
	p, err := New[*obj](Config[*obj]{
		Factory: tr.factory,
		Reset:   func(*obj) error { return nil },
		Destroy: tr.destroy,
		Max:     2,
	})
	if err != nil {
		t.Fatal(err)
	}

	a, err := p.Get(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	b, err := p.Get(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	p.Put(a) // goes idle
	p.Close()

	// Object checked out before Close is destroyed when returned.
	p.Put(b)
	if got := p.Live(); got != 0 {
		t.Fatalf("Live = %d, want 0", got)
	}
	if _, err := p.Get(context.Background()); !errors.Is(err, ErrClosed) {
		t.Fatalf("Get on closed pool returned %v, want ErrClosed", err)
	}
	tr.verify(t)
}

func TestWaitersUnblockedOnClose(t *testing.T) {
	tr := newTracker()
	p, err := New[*obj](Config[*obj]{
		Factory: tr.factory,
		Destroy: tr.destroy,
		Max:     1,
	})
	if err != nil {
		t.Fatal(err)
	}
	held, err := p.Get(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	const waiters = 8
	start := make(chan struct{})
	var wg sync.WaitGroup
	errs := make([]error, waiters)
	for i := 0; i < waiters; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			_, errs[i] = p.Get(context.Background())
		}(i)
	}
	close(start)
	time.Sleep(50 * time.Millisecond) // let all waiters block
	p.Close()
	wg.Wait()
	for i, err := range errs {
		if !errors.Is(err, ErrClosed) {
			t.Fatalf("waiter %d got %v, want ErrClosed", i, err)
		}
	}
	p.Put(held) // returned after close: destroyed
	tr.verify(t)
}

func TestConcurrentCloseNoLeak(t *testing.T) {
	for iter := 0; iter < 20; iter++ {
		t.Run(fmt.Sprintf("iter-%d", iter), func(t *testing.T) {
			tr := newTracker()
			p, err := New[*obj](Config[*obj]{
				Factory: tr.factory,
				Reset:   func(*obj) error { return nil },
				Destroy: tr.destroy,
				Max:     4,
			})
			if err != nil {
				t.Fatal(err)
			}

			const workers = 16
			start := make(chan struct{})
			stop := make(chan struct{})
			var wg sync.WaitGroup
			for i := 0; i < workers; i++ {
				wg.Add(1)
				go func() {
					defer wg.Done()
					<-start
					for {
						select {
						case <-stop:
							return
						default:
						}
						o, err := p.Get(context.Background())
						if err != nil {
							if errors.Is(err, ErrClosed) {
								return
							}
							t.Errorf("Get: %v", err)
							return
						}
						p.Put(o)
					}
				}()
			}
			close(start)
			time.Sleep(time.Millisecond)
			p.Close()
			close(stop)
			wg.Wait()

			if got := p.Live(); got != 0 {
				t.Fatalf("Live after concurrent close = %d, want 0", got)
			}
			tr.verify(t)
		})
	}
}

func TestConcurrentFactoryFailureAndCloseNoLeak(t *testing.T) {
	tr := newTracker()
	var fail atomic.Bool
	p, err := New[*obj](Config[*obj]{
		Factory: func(ctx context.Context) (*obj, error) {
			time.Sleep(time.Millisecond) // widen the in-flight window
			if fail.Load() {
				return nil, errors.New("factory boom")
			}
			return tr.factory(ctx)
		},
		Destroy: tr.destroy,
		Max:     4,
	})
	if err != nil {
		t.Fatal(err)
	}

	const workers = 16
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			for j := 0; j < 20; j++ {
				fail.Store(j%3 == 0)
				o, err := p.Get(context.Background())
				if err != nil {
					if errors.Is(err, ErrClosed) {
						return
					}
					continue // factory failure: slot must have been released
				}
				p.Put(o)
			}
		}(i)
	}
	close(start)
	time.Sleep(5 * time.Millisecond)
	p.Close()
	wg.Wait()

	if got := p.Live(); got != 0 {
		t.Fatalf("Live after factory failures + close = %d, want 0", got)
	}
	tr.verify(t)
}
