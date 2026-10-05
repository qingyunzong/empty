package pool

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

// trackedObj is the pooled resource in tests.
type trackedObj struct{ id int }

// tracker records produce/reset/destroy calls and enforces lifecycle
// invariants: live objects never exceed a bound known to the test, and no
// object is destroyed twice.
type tracker struct {
	mu        sync.Mutex
	nextID    int
	live      int
	maxLive   int
	destroyed map[int]int
	produced  int

	resetErr   func(id int) error
	produceErr func() error
}

func newTracker() *tracker {
	return &tracker{destroyed: make(map[int]int)}
}

func (tr *tracker) produce(context.Context) (trackedObj, error) {
	if tr.produceErr != nil {
		if err := tr.produceErr(); err != nil {
			return trackedObj{}, err
		}
	}
	tr.mu.Lock()
	defer tr.mu.Unlock()
	tr.nextID++
	tr.produced++
	tr.live++
	if tr.live > tr.maxLive {
		tr.maxLive = tr.live
	}
	return trackedObj{id: tr.nextID}, nil
}

func (tr *tracker) reset(_ context.Context, o trackedObj) error {
	if tr.resetErr != nil {
		return tr.resetErr(o.id)
	}
	return nil
}

func (tr *tracker) destroy(o trackedObj) {
	tr.mu.Lock()
	defer tr.mu.Unlock()
	tr.destroyed[o.id]++
	tr.live--
}

func (tr *tracker) snapshot() (produced, live, maxLive int) {
	tr.mu.Lock()
	defer tr.mu.Unlock()
	return tr.produced, tr.live, tr.maxLive
}

// verifyExactlyOnce fails the test if any object was destroyed zero or
// multiple times, or if any object is still live.
func (tr *tracker) verifyExactlyOnce(t *testing.T) {
	t.Helper()
	tr.mu.Lock()
	defer tr.mu.Unlock()
	if tr.live != 0 {
		t.Errorf("live objects after drain = %d, want 0", tr.live)
	}
	if len(tr.destroyed) != tr.produced {
		t.Errorf("destroyed %d distinct objects, produced %d", len(tr.destroyed), tr.produced)
	}
	for id, n := range tr.destroyed {
		if n != 1 {
			t.Errorf("object %d destroyed %d times, want exactly 1", id, n)
		}
	}
}

// barrier is a reusable rendezvous for n goroutines.
type barrier struct {
	c     *sync.Cond
	n     int
	count int
	gen   uint64
}

func newBarrier(n int) *barrier {
	return &barrier{c: sync.NewCond(&sync.Mutex{}), n: n}
}

func (b *barrier) wait() {
	b.c.L.Lock()
	gen := b.gen
	b.count++
	if b.count == b.n {
		b.count = 0
		b.gen++
		b.c.Broadcast()
	} else {
		for gen == b.gen {
			b.c.Wait()
		}
	}
	b.c.L.Unlock()
}

func TestResetFailureDestroysAndReleasesSlot(t *testing.T) {
	tr := newTracker()
	tr.resetErr = func(id int) error {
		if id%2 == 0 {
			return fmt.Errorf("object %d failed validation", id)
		}
		return nil
	}
	p := New(2, tr.produce, tr.reset, tr.destroy)
	ctx := context.Background()

	a, err := p.Borrow(ctx) // id 1
	if err != nil {
		t.Fatal(err)
	}
	b, err := p.Borrow(ctx) // id 2
	if err != nil {
		t.Fatal(err)
	}
	p.Return(ctx, a) // reset ok -> idle
	p.Return(ctx, b) // reset fails -> destroyed, slot released

	if idle, slots := p.Stats(); idle != 1 || slots != 1 {
		t.Fatalf("Stats = (%d idle, %d slots), want (1, 1)", idle, slots)
	}
	// The released slot must be borrowable again without blocking.
	c, err := p.Borrow(ctx) // id 3
	if err != nil {
		t.Fatal(err)
	}
	p.Return(ctx, c)
	p.Close()
	tr.verifyExactlyOnce(t)
}

func TestCloseDestroysReturnedLoans(t *testing.T) {
	tr := newTracker()
	p := New(3, tr.produce, tr.reset, tr.destroy)
	ctx := context.Background()

	objs := make([]trackedObj, 3)
	for i := range objs {
		o, err := p.Borrow(ctx)
		if err != nil {
			t.Fatal(err)
		}
		objs[i] = o
	}
	p.Return(ctx, objs[0]) // goes idle
	p.Close()              // destroys the idle one
	p.Return(ctx, objs[1]) // loan returned after close -> destroyed
	p.Return(ctx, objs[2])

	if idle, slots := p.Stats(); idle != 0 || slots != 0 {
		t.Fatalf("Stats = (%d idle, %d slots), want (0, 0)", idle, slots)
	}
	tr.verifyExactlyOnce(t)
}

func TestWaiterCancellation(t *testing.T) {
	tr := newTracker()
	p := New(1, tr.produce, tr.reset, tr.destroy)
	ctx := context.Background()

	held, err := p.Borrow(ctx)
	if err != nil {
		t.Fatal(err)
	}

	waitCtx, cancel := context.WithCancel(ctx)
	errCh := make(chan error, 1)
	go func() {
		_, err := p.Borrow(waitCtx)
		errCh <- err
	}()
	// Let the waiter enqueue, then cancel it.
	time.Sleep(20 * time.Millisecond)
	cancel()
	if err := <-errCh; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled waiter got %v, want context.Canceled", err)
	}

	// A second waiter must be failed by Close.
	errCh2 := make(chan error, 1)
	go func() {
		_, err := p.Borrow(ctx)
		errCh2 <- err
	}()
	time.Sleep(20 * time.Millisecond)
	p.Close()
	if err := <-errCh2; !errors.Is(err, ErrClosed) {
		t.Fatalf("waiter after close got %v, want ErrClosed", err)
	}

	p.Return(ctx, held) // destroyed on return after close
	tr.verifyExactlyOnce(t)
}

func TestProduceFailureReleasesSlot(t *testing.T) {
	tr := newTracker()
	boom := errors.New("factory down")
	tr.produceErr = func() error { return boom }
	p := New(4, tr.produce, tr.reset, tr.destroy)

	for i := 0; i < 10; i++ {
		if _, err := p.Borrow(context.Background()); !errors.Is(err, boom) {
			t.Fatalf("Borrow err = %v, want %v", err, boom)
		}
	}
	if idle, slots := p.Stats(); idle != 0 || slots != 0 {
		t.Fatalf("Stats = (%d idle, %d slots), want (0, 0): slot leak", idle, slots)
	}
	p.Close()
}

// TestBarrierConcurrency releases many goroutines from a barrier
// simultaneously, has them borrow/return in a tight loop with occasional
// reset and produce failures, and closes the pool mid-flight. It then
// verifies: max live objects never exceeded capacity, every produced object
// was destroyed exactly once, and no reserved slot leaked.
func TestBarrierConcurrency(t *testing.T) {
	const (
		max       = 8
		workers   = 32
		perWorker = 200
	)
	tr := newTracker()
	// Intermittent failures exercise the destroy/release paths under load.
	tr.resetErr = func(id int) error {
		if id%5 == 0 {
			return errors.New("transient reset failure")
		}
		return nil
	}
	var produceGate sync.Mutex
	produceCalls := 0
	tr.produceErr = func() error {
		produceGate.Lock()
		defer produceGate.Unlock()
		produceCalls++
		if produceCalls%11 == 0 {
			return errors.New("transient produce failure")
		}
		return nil
	}

	p := New(max, tr.produce, tr.reset, tr.destroy)
	bar := newBarrier(workers + 1) // workers + closer

	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			bar.wait()
			ctx := context.Background()
			for j := 0; j < perWorker; j++ {
				o, err := p.Borrow(ctx)
				if errors.Is(err, ErrClosed) {
					return
				}
				if err != nil {
					continue // transient produce failure
				}
				p.Return(ctx, o)
			}
		}(i)
	}

	// Closer: release everyone at once, then close mid-flight.
	bar.wait()
	time.Sleep(time.Millisecond)
	p.Close()
	wg.Wait()

	if idle, slots := p.Stats(); idle != 0 || slots != 0 {
		t.Fatalf("Stats = (%d idle, %d slots), want (0, 0): slot leak", idle, slots)
	}
	_, live, maxLive := tr.snapshot()
	if maxLive > max {
		t.Fatalf("max live objects = %d, exceeds capacity %d", maxLive, max)
	}
	if live != 0 {
		t.Fatalf("live objects after drain = %d, want 0", live)
	}
	tr.verifyExactlyOnce(t)
	t.Logf("produced/destroyed drained cleanly; maxLive=%d (capacity %d)", maxLive, max)
}

// TestBarrierCancellationStorm cancels waiters while objects are being
// returned, checking that cancelled waiters never strand a handoff.
func TestBarrierCancellationStorm(t *testing.T) {
	const max = 4
	tr := newTracker()
	p := New(max, tr.produce, tr.reset, tr.destroy)

	held := make([]trackedObj, max)
	for i := range held {
		o, err := p.Borrow(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		held[i] = o
	}

	const waitersN = 64
	bar := newBarrier(waitersN + 1)
	var wg sync.WaitGroup
	for i := 0; i < waitersN; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), time.Duration(i%7)*time.Millisecond)
			defer cancel()
			bar.wait()
			o, err := p.Borrow(ctx)
			if err == nil {
				p.Return(context.Background(), o)
			}
		}(i)
	}
	bar.wait()
	for _, o := range held {
		p.Return(context.Background(), o)
	}
	wg.Wait()
	p.Close()

	if idle, slots := p.Stats(); idle != 0 || slots != 0 {
		t.Fatalf("Stats = (%d idle, %d slots), want (0, 0): slot leak", idle, slots)
	}
	tr.verifyExactlyOnce(t)
}
