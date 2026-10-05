package taskpool

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
)

// barrier is a two-party rendezvous used to drive deterministic
// interleavings: the instrumented party crosses while the driver decides
// when to release it, so a test can enumerate the orderings of two racing
// operations.
type barrier struct {
	arrive  chan struct{}
	proceed chan struct{}
}

func newBarrier() *barrier {
	return &barrier{arrive: make(chan struct{}), proceed: make(chan struct{})}
}

// cross is called by the instrumented party; it blocks until released.
func (b *barrier) cross() {
	close(b.arrive)
	<-b.proceed
}

// wait blocks until the instrumented party arrives at the barrier.
func (b *barrier) wait() { <-b.arrive }

// release lets the instrumented party cross the barrier.
func (b *barrier) release() { close(b.proceed) }

// TestCancelStartInterleavings enumerates the orderings of Cancel versus
// task start and checks the ticket lands in exactly one terminal state.
func TestCancelStartInterleavings(t *testing.T) {
	t.Run("cancel-before-start", func(t *testing.T) {
		b := newBarrier()
		p := New(1)
		p.beforeStart = b.cross
		var ran atomic.Bool
		tk, err := p.Submit(func(ctx context.Context) (any, error) {
			ran.Store(true)
			return "ok", nil
		})
		if err != nil {
			t.Fatal(err)
		}
		b.wait() // worker parked right before the start transition
		if !tk.Cancel() {
			t.Fatal("Cancel of a pending ticket should win")
		}
		b.release()
		p.beforeStart = nil
		p.Wait()
		if ran.Load() {
			t.Fatal("canceled task must never run")
		}
		if _, err := tk.Claim(); !errors.Is(err, ErrCanceled) {
			t.Fatalf("Claim after cancel = %v, want ErrCanceled", err)
		}
		if got := tk.State(); got != Canceled {
			t.Fatalf("state = %v, want Canceled", got)
		}
		assertCapacityReturned(t, p)
	})

	t.Run("start-before-cancel", func(t *testing.T) {
		bStart := newBarrier()
		bRunning := newBarrier()
		p := New(1)
		p.beforeStart = bStart.cross
		p.afterStart = bRunning.cross
		tk, err := p.Submit(func(ctx context.Context) (any, error) {
			<-ctx.Done() // react to the cancel signal
			return "signal-observed", ctx.Err()
		})
		if err != nil {
			t.Fatal(err)
		}
		bStart.wait()
		bStart.release()
		p.beforeStart = nil
		bRunning.wait() // task is now running
		if !tk.Cancel() {
			t.Fatal("Cancel of a running ticket should send the signal")
		}
		p.afterStart = nil
		bRunning.release()
		v, err := tk.Claim()
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("task err = %v, want context.Canceled", err)
		}
		if v != "signal-observed" {
			t.Fatalf("result = %v, cancel of a running task must only signal", v)
		}
		if got := tk.State(); got != Claimed {
			t.Fatalf("state = %v, want Claimed", got)
		}
		assertCapacityReturned(t, p)
	})
}

// TestClaimCancelInterleavings races Claim against Cancel on a finished
// task and checks that exactly one of them wins in every interleaving.
func TestClaimCancelInterleavings(t *testing.T) {
	const iterations = 500
	var claimWon, cancelWon atomic.Bool
	for i := 0; i < iterations; i++ {
		p := New(1)
		tk, err := p.Submit(func(ctx context.Context) (any, error) { return i, nil })
		if err != nil {
			t.Fatal(err)
		}
		<-tk.Done() // result ready, still unclaimed

		gate := make(chan struct{})
		var wg sync.WaitGroup
		var claimVal any
		var claimErr error
		var cancelOK bool
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-gate
			claimVal, claimErr = tk.Claim()
		}()
		go func() {
			defer wg.Done()
			<-gate
			cancelOK = tk.Cancel()
		}()
		close(gate)
		wg.Wait()

		switch {
		case claimErr == nil && !cancelOK:
			claimWon.Store(true)
			if claimVal != i {
				t.Fatalf("claimed %v, want %v", claimVal, i)
			}
			if got := tk.State(); got != Claimed {
				t.Fatalf("state = %v, want Claimed", got)
			}
		case errors.Is(claimErr, ErrCanceled) && cancelOK:
			cancelWon.Store(true)
			if got := tk.State(); got != Canceled {
				t.Fatalf("state = %v, want Canceled", got)
			}
		default:
			t.Fatalf("inconsistent terminal state: claim=(%v,%v) cancel=%v",
				claimVal, claimErr, cancelOK)
		}
		p.Close()
		p.Wait()
	}
	if !claimWon.Load() || !cancelWon.Load() {
		t.Fatalf("interleavings not enumerated: claimWon=%v cancelWon=%v",
			claimWon.Load(), cancelWon.Load())
	}
}
