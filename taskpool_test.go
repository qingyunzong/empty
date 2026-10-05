package taskpool

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// assertCapacityReturned verifies a slot was handed back to the pool by
// submitting one more task and requiring it to complete.
func assertCapacityReturned(t *testing.T, p *Pool) {
	t.Helper()
	type out struct {
		tk  *Ticket
		err error
	}
	ch := make(chan out, 1)
	go func() {
		tk, err := p.Submit(func(ctx context.Context) (any, error) {
			return "slot-free", nil
		})
		ch <- out{tk, err}
	}()
	select {
	case o := <-ch:
		if o.err != nil {
			t.Fatalf("submit after terminal state: %v", o.err)
		}
		if v, err := o.tk.Claim(); err != nil || v != "slot-free" {
			t.Fatalf("claim = (%v, %v), want (slot-free, nil)", v, err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("capacity was not returned to the pool")
	}
}

func TestSubmitClaim(t *testing.T) {
	p := New(2)
	defer p.Close()
	tk, err := p.Submit(func(ctx context.Context) (any, error) {
		return 42, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	v, err := tk.Claim()
	if err != nil || v != 42 {
		t.Fatalf("Claim = (%v, %v), want (42, nil)", v, err)
	}
	if tk.Cancel() {
		t.Fatal("Cancel after claim must fail")
	}
	if got := tk.State(); got != Claimed {
		t.Fatalf("state = %v, want Claimed", got)
	}
	p.Wait()
	assertCapacityReturned(t, p)
}

func TestCapacityReturnedAfterCancel(t *testing.T) {
	p := New(1)
	defer p.Close()
	started := make(chan struct{})
	tk, err := p.Submit(func(ctx context.Context) (any, error) {
		close(started)
		<-ctx.Done() // finish only once the cancel signal arrives
		return nil, ctx.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	<-started
	if !tk.Cancel() {
		t.Fatal("Cancel of running ticket should signal")
	}
	if _, err := tk.Claim(); !errors.Is(err, context.Canceled) {
		t.Fatalf("Claim = %v, want context.Canceled", err)
	}
	p.Wait()
	assertCapacityReturned(t, p)
}

func TestClaimOnlyOnce(t *testing.T) {
	p := New(2)
	defer p.Close()
	tk, err := p.Submit(func(ctx context.Context) (any, error) {
		return "prize", nil
	})
	if err != nil {
		t.Fatal(err)
	}
	<-tk.Done()
	const claimers = 8
	var wins atomic.Int32
	var wg sync.WaitGroup
	gate := make(chan struct{})
	for i := 0; i < claimers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-gate
			v, err := tk.Claim()
			switch {
			case err == nil:
				if v != "prize" {
					t.Errorf("claimed %v, want prize", v)
				}
				wins.Add(1)
			case !errors.Is(err, ErrClaimed):
				t.Errorf("Claim = %v, want ErrClaimed", err)
			}
		}()
	}
	close(gate)
	wg.Wait()
	if got := wins.Load(); got != 1 {
		t.Fatalf("result claimed %d times, want exactly 1", got)
	}
}

func TestCloseReleasesAllWaiters(t *testing.T) {
	p := New(1)
	unblock := make(chan struct{})
	tk, err := p.Submit(func(ctx context.Context) (any, error) {
		<-unblock
		return "blocker", nil
	})
	if err != nil {
		t.Fatal(err)
	}

	const waiters = 8
	errs := make(chan error, waiters)
	for i := 0; i < waiters; i++ {
		go func() {
			_, err := p.Submit(func(ctx context.Context) (any, error) {
				return nil, nil
			})
			errs <- err
		}()
	}
	// Give the waiters time to pile up on the full pool.
	time.Sleep(100 * time.Millisecond)
	p.Close()
	for i := 0; i < waiters; i++ {
		select {
		case err := <-errs:
			if !errors.Is(err, ErrClosed) {
				t.Fatalf("waiter exited with %v, want ErrClosed", err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("waiter still blocked after Close")
		}
	}
	if _, err := p.Submit(func(ctx context.Context) (any, error) {
		return nil, nil
	}); !errors.Is(err, ErrClosed) {
		t.Fatalf("Submit after Close = %v, want ErrClosed", err)
	}

	close(unblock)
	p.Wait()
	if v, err := tk.Claim(); err != nil || v != "blocker" {
		t.Fatalf("in-flight task lost after Close: (%v, %v)", v, err)
	}
}
