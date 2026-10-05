package taskpool

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// barrier releases every arrival once n goroutines have arrived, letting
// a test enumerate interleavings deterministically.
type barrier struct {
	n       int64
	arrived int64
	ch      chan struct{}
}

func newBarrier(n int) *barrier { return &barrier{n: int64(n), ch: make(chan struct{})} }

func (b *barrier) await() {
	if atomic.AddInt64(&b.arrived, 1) == b.n {
		close(b.ch)
		return
	}
	<-b.ch
}

func waitForState(t *testing.T, tk *Ticket, want State) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for tk.State() != want {
		if time.Now().After(deadline) {
			t.Fatalf("state = %s, want %s", tk.State(), want)
		}
		time.Sleep(time.Millisecond)
	}
}

// drain submits capacity tasks that must all complete, proving every slot
// was returned to the pool.
func drain(t *testing.T, p *Pool) {
	t.Helper()
	var wg sync.WaitGroup
	for i := 0; i < p.Capacity(); i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			tk, err := p.Submit(ctx, func(context.Context) (any, error) { return nil, nil })
			if err != nil {
				t.Errorf("capacity not returned: Submit: %v", err)
				return
			}
			if _, err := tk.Result(ctx); err != nil {
				t.Errorf("capacity not returned: Result: %v", err)
			}
		}()
	}
	wg.Wait()
}

// TestInterleavings enumerates the critical orderings of cancel, start,
// and claim with barriers, checking the ticket reaches exactly one
// terminal state in each.
func TestInterleavings(t *testing.T) {
	t.Run("CancelBeforeStart", func(t *testing.T) {
		p := New(1)
		defer p.Close()
		entered := make(chan struct{})
		release := make(chan struct{})
		var once sync.Once
		p.preStart = func() { once.Do(func() { close(entered); <-release }) } // park while Pending
		var ran atomic.Bool
		tk, err := p.Submit(context.Background(), func(context.Context) (any, error) {
			ran.Store(true)
			return nil, nil
		})
		if err != nil {
			t.Fatal(err)
		}
		<-entered // worker parked, ticket still Pending
		if !tk.Cancel() {
			t.Fatal("Cancel of pending ticket should succeed")
		}
		close(release)

		if ran.Load() {
			t.Fatal("cancelled ticket must never run")
		}
		if got := tk.State(); got != Cancelled {
			t.Fatalf("state = %s, want Cancelled", got)
		}
		if _, err := tk.Result(context.Background()); !errors.Is(err, ErrCancelled) {
			t.Fatalf("Result err = %v, want ErrCancelled", err)
		}
		if tk.Cancel() {
			t.Fatal("second Cancel must fail: terminal state already reached")
		}
		drain(t, p) // capacity returned
	})

	t.Run("StartBeforeCancel", func(t *testing.T) {
		p := New(1)
		defer p.Close()
		started := make(chan struct{})
		tk, err := p.Submit(context.Background(), func(ctx context.Context) (any, error) {
			close(started)
			<-ctx.Done() // cancel only signals; the task decides to stop
			return nil, ctx.Err()
		})
		if err != nil {
			t.Fatal(err)
		}
		<-started
		waitForState(t, tk, Running)
		if !tk.Cancel() {
			t.Fatal("Cancel of running ticket should signal")
		}
		if _, err := tk.Result(context.Background()); !errors.Is(err, context.Canceled) {
			t.Fatalf("Result err = %v, want context.Canceled", err)
		}
		if got := tk.State(); got != Claimed {
			t.Fatalf("state = %s, want Claimed", got)
		}
		if tk.Cancel() {
			t.Fatal("Cancel after claim must fail")
		}
		drain(t, p)
	})

	t.Run("ClaimThenCancel", func(t *testing.T) {
		p := New(1)
		defer p.Close()
		tk, err := p.Submit(context.Background(), func(context.Context) (any, error) { return 42, nil })
		if err != nil {
			t.Fatal(err)
		}
		got, err := tk.Result(context.Background())
		if err != nil || got != 42 {
			t.Fatalf("Result = %v, %v; want 42, nil", got, err)
		}
		if tk.Cancel() {
			t.Fatal("Cancel after claim must fail")
		}
		if _, err := tk.Result(context.Background()); !errors.Is(err, ErrAlreadyClaimed) {
			t.Fatalf("second Result err = %v, want ErrAlreadyClaimed", err)
		}
		if got := tk.State(); got != Claimed {
			t.Fatalf("state = %s, want Claimed", got)
		}
		drain(t, p)
	})

	t.Run("ConcurrentClaims", func(t *testing.T) {
		// Enumerate the race 100 times: exactly one of two racing claims wins.
		for i := 0; i < 100; i++ {
			p := New(1)
			tk, err := p.Submit(context.Background(), func(context.Context) (any, error) { return i, nil })
			if err != nil {
				t.Fatal(err)
			}
			gate := newBarrier(2)
			wins := make(chan any, 2)
			claim := func() {
				gate.await()
				v, err := tk.Result(context.Background())
				if err == nil {
					wins <- v
				} else if !errors.Is(err, ErrAlreadyClaimed) {
					t.Errorf("losing claim err = %v, want ErrAlreadyClaimed", err)
				}
			}
			go claim()
			go claim()
			v := <-wins
			if v != i {
				t.Fatalf("claimed %v, want %d", v, i)
			}
			select {
			case extra := <-wins:
				t.Fatalf("second claim won with %v: terminal state reached twice", extra)
			case <-time.After(10 * time.Millisecond):
			}
			if got := tk.State(); got != Claimed {
				t.Fatalf("state = %s, want Claimed", got)
			}
			p.Close()
		}
	})
}

// TestCapacityReturned checks that slots come back after done, cancelled,
// and closed-out tasks, and that a full pool blocks Submit.
func TestCapacityReturned(t *testing.T) {
	p := New(2)
	defer p.Close()
	release := make(chan struct{})
	started := newBarrier(2)
	blocking := func(ctx context.Context) (any, error) {
		started.await()
		select {
		case <-release:
			return "ok", nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	tk1, err := p.Submit(context.Background(), blocking)
	if err != nil {
		t.Fatal(err)
	}
	tk2, err := p.Submit(context.Background(), blocking)
	if err != nil {
		t.Fatal(err)
	}
	waitForState(t, tk1, Running)
	waitForState(t, tk2, Running)

	// Pool full: Submit must block and respect its context.
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := p.Submit(ctx, blocking); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("full pool Submit err = %v, want DeadlineExceeded", err)
	}

	close(release)
	for i, tk := range []*Ticket{tk1, tk2} {
		v, err := tk.Result(context.Background())
		if err != nil || v != "ok" {
			t.Fatalf("ticket %d Result = %v, %v", i, v, err)
		}
	}
	drain(t, p) // both slots returned
}

// TestCloseReleasesWaiters checks that after Close every waiter exits:
// blocked Submit calls fail with ErrClosed and Result waiters unblock.
func TestCloseReleasesWaiters(t *testing.T) {
	p := New(1)
	tk, err := p.Submit(context.Background(), func(ctx context.Context) (any, error) {
		<-ctx.Done() // Close signals running tasks
		return nil, ctx.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	waitForState(t, tk, Running)

	aboutToSubmit := make(chan struct{})
	submitErr := make(chan error, 1)
	go func() {
		close(aboutToSubmit)
		_, err := p.Submit(context.Background(), func(context.Context) (any, error) { return nil, nil })
		submitErr <- err
	}()
	<-aboutToSubmit
	time.Sleep(20 * time.Millisecond) // let the waiter block on the full pool

	resultErr := make(chan error, 1)
	go func() {
		_, err := tk.Result(context.Background())
		resultErr <- err
	}()

	p.Close()

	if err := <-submitErr; !errors.Is(err, ErrClosed) {
		t.Fatalf("blocked Submit err = %v, want ErrClosed", err)
	}
	if err := <-resultErr; !errors.Is(err, context.Canceled) {
		t.Fatalf("waiter Result err = %v, want context.Canceled", err)
	}
	if _, err := p.Submit(context.Background(), func(context.Context) (any, error) { return nil, nil }); !errors.Is(err, ErrClosed) {
		t.Fatalf("Submit after Close err = %v, want ErrClosed", err)
	}
	p.Close() // idempotent
}

// TestTerminalStateUniqueness hammers cancel/claim races and verifies
// every ticket ends in exactly one terminal state and all capacity returns.
func TestTerminalStateUniqueness(t *testing.T) {
	p := New(4)
	defer p.Close()
	for i := 0; i < 200; i++ {
		tk, err := p.Submit(context.Background(), func(context.Context) (any, error) { return i, nil })
		if err != nil {
			t.Fatal(err)
		}
		gate := newBarrier(2)
		var claimed atomic.Int64
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { // racer 1: cancel
			defer wg.Done()
			gate.await()
			tk.Cancel()
		}()
		go func() { // racer 2: claim
			defer wg.Done()
			gate.await()
			if _, err := tk.Result(context.Background()); err == nil {
				claimed.Add(1)
			} else if !errors.Is(err, ErrCancelled) && !errors.Is(err, ErrAlreadyClaimed) {
				t.Errorf("Result err = %v", err)
			}
		}()
		wg.Wait()

		got := tk.State()
		if !got.Terminal() {
			t.Fatalf("iter %d: state = %s, want terminal", i, got)
		}
		if got == Cancelled && claimed.Load() != 0 {
			t.Fatalf("iter %d: cancelled ticket was claimed", i)
		}
		if got == Claimed && claimed.Load() != 1 {
			t.Fatalf("iter %d: claimed %d times, want exactly 1", i, claimed.Load())
		}
	}
	drain(t, p) // no capacity leaked across all iterations
}
